'use strict';

const WS_URL = `ws://${location.host}/ws`;

let ws;
const terminals = {};   // agentName → { term, fitAddon }
const taskContent = {}; // agentName → latest raw markdown content

function connect() {
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'agents' }));
    fetchCosts();
    populateModelDropdown();
    fetchSuggestions();
  });

  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'agents':
        msg.list.forEach(agent => ensurePanel(agent));
        updateAgentCount();
        break;
      case 'output':
        terminals[msg.agent]?.term.write(msg.data);
        break;
      case 'status':
        updateStatus(msg.agent, msg.status);
        break;
      case 'tasks':
        taskContent[msg.agent] = msg.content;
        renderTasks(msg.agent, msg.content);
        break;
      case 'cost':
        updateAgentCost(msg.agent, msg.today);
        break;

      case 'agent_removed': {
        const panel = document.getElementById(`panel-${escHtml(msg.agent)}`);
        if (panel) panel.remove();
        delete terminals[msg.agent];
        delete taskContent[msg.agent];
        updateAgentCount();
        break;
      }

      case 'worktree_pending': {
        const headerRight = document.getElementById(`header-right-${escHtml(msg.agent)}`);
        if (!headerRight) break;
        headerRight.innerHTML = `
          <span class="panel-cost" id="cost-${escHtml(msg.agent)}">$0.00 today</span>
          <span class="badge badge-pr-open" id="pr-badge-${escHtml(msg.agent)}">creating PR…</span>
        `;
        break;
      }

      case 'worktree_discarded':
        restoreKillButton(msg.agent);
        break;

      case 'worktree_pr':
        showPRLink(msg.agent, msg.prUrl, msg.prNumber);
        break;

      case 'worktree_pr_failed': {
        const headerRight = document.getElementById(`header-right-${escHtml(msg.agent)}`);
        if (!headerRight) break;
        headerRight.innerHTML = `
          <span class="panel-cost" id="cost-${escHtml(msg.agent)}">$0.00 today</span>
          <span class="badge badge-pr-closed" id="pr-badge-${escHtml(msg.agent)}">PR failed</span>
          <button class="btn-discard" id="discard-failed-${escHtml(msg.agent)}">Discard</button>
        `;
        const discardBtn = document.getElementById(`discard-failed-${escHtml(msg.agent)}`);
        if (discardBtn) {
          discardBtn.addEventListener('click', () => {
            fetch(`/worktrees/${encodeURIComponent(msg.agent)}`, { method: 'DELETE' })
              .then(() => restoreKillButton(msg.agent))
              .catch(err => console.error('Discard failed:', err));
          });
        }
        break;
      }

      case 'pr_status':
        updatePRBadge(msg.agent, msg.status);
        if (msg.status === 'merged' || msg.status === 'closed') {
          restoreKillButton(msg.agent);
        }
        break;

      case 'suggestion':
        renderSuggestionCard(msg.suggestion);
        showSuggestionsStrip();
        break;
    }
  });

  ws.addEventListener('close', () => setTimeout(connect, 2000));
}

function ensurePanel({ name, mode, status, isolate }) {
  if (document.getElementById(`panel-${name}`)) return;

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = `panel-${name}`;
  panel.innerHTML = `
    <div class="panel-header">
      <div style="display:flex;align-items:center;gap:0">
        <span class="panel-name">${escHtml(name)}</span>
        <span class="badge badge-${status}" id="badge-${name}">${status}</span>
        ${mode === 'observe' ? '<span class="badge badge-observe">observe</span>' : ''}
        ${isolate ? `<span class="badge badge-isolated" id="isolated-badge-${name}">isolated</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px" id="header-right-${name}">
        <span class="panel-cost" id="cost-${name}">$0.00 today</span>
        <button class="btn-kill" data-agent="${name}">Kill</button>
      </div>
    </div>
    <div class="panel-body">
      <div class="terminal-wrap" id="term-${name}"></div>
      <div class="task-sidebar">
        <h4>Tasks</h4>
        <div class="task-list" id="tasks-${name}"></div>
        <div class="task-add">
          <input type="text" id="task-input-${name}" placeholder="Add task…">
          <button data-add="${name}">+</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('panels').appendChild(panel);

  // Init xterm.js terminal
  const term = new Terminal({
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff' },
    fontSize: 12,
    cursorBlink: true,
    scrollback: 5000,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById(`term-${name}`));
  fitAddon.fit();
  term.focus();
  terminals[name] = { term, fitAddon };

  // Re-focus terminal on click
  document.getElementById(`term-${name}`)?.addEventListener('click', () => term.focus());

  // Keyboard input → server
  term.onData(data => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', agent: name, data }));
    }
  });

  // Subscribe to agent stream
  ws.send(JSON.stringify({ type: 'subscribe', agent: name }));

  // Kill button
  panel.querySelector('.btn-kill').addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'kill', agent: name }));
  });

  // Add task button + Enter key
  const taskInput = panel.querySelector(`#task-input-${name}`);
  panel.querySelector('[data-add]').addEventListener('click', () => addTask(name));
  taskInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTask(name); });

  // Poll tasks every 5s
  setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'tasks_get', agent: name }));
    }
  }, 5000);

  updateAgentCount();
}

function updateStatus(name, status) {
  const badge = document.getElementById(`badge-${name}`);
  if (!badge) return;
  badge.textContent = status;
  badge.className = `badge badge-${status}`;

  const headerRight = document.getElementById(`header-right-${name}`);
  if (!headerRight) return;
  const existingKill = headerRight.querySelector('.btn-kill');
  const existingRemove = headerRight.querySelector('.btn-remove');

  if (status === 'stopped' && existingKill && !existingRemove) {
    existingKill.textContent = 'Remove';
    existingKill.className = 'btn-remove';
    existingKill.replaceWith(existingKill.cloneNode(true)); // detach old listener
    const removeBtn = headerRight.querySelector('.btn-remove');
    removeBtn.addEventListener('click', () => {
      fetch(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
    });
  } else if (status === 'running' && existingRemove) {
    existingRemove.textContent = 'Kill';
    existingRemove.className = 'btn-kill';
    existingRemove.replaceWith(existingRemove.cloneNode(true));
    const killBtn = headerRight.querySelector('.btn-kill');
    killBtn.addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'kill', agent: name }));
    });
  }
}

function updateAgentCost(name, today) {
  const el = document.getElementById(`cost-${name}`);
  if (el) el.textContent = `$${today.toFixed(2)} today`;
}

function updateAgentCount() {
  document.getElementById('agent-count').textContent =
    `${document.querySelectorAll('.panel').length} agents`;
}

function renderTasks(agentName, content) {
  const container = document.getElementById(`tasks-${agentName}`);
  if (!container) return;
  const lines = content.split('\n');
  container.innerHTML = '';
  lines.forEach((line, i) => {
    const checked = line.startsWith('- [x]');
    const unchecked = line.startsWith('- [ ]');
    if (!checked && !unchecked) return;
    const text = line.replace(/^- \[.\] /, '');
    const item = document.createElement('div');
    item.className = `task-item${checked ? ' done' : ''}`;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => toggleTask(agentName, i, cb.checked));
    const label = document.createElement('span');
    label.textContent = text;
    item.append(cb, label);
    container.appendChild(item);
  });
}

function toggleTask(agentName, lineIndex, checked) {
  const content = taskContent[agentName] ?? '';
  const lines = content.split('\n');
  if (!lines[lineIndex]) return;
  lines[lineIndex] = lines[lineIndex]
    .replace(checked ? '- [ ]' : '- [x]', checked ? '- [x]' : '- [ ]');
  const newContent = lines.join('\n');
  taskContent[agentName] = newContent;
  ws.send(JSON.stringify({ type: 'tasks_set', agent: agentName, content: newContent }));
}

function addTask(agentName) {
  const input = document.getElementById(`task-input-${agentName}`);
  const task = input.value.trim();
  if (!task) return;
  input.value = '';
  fetch(`/tasks/${agentName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
  }).then(() => {
    ws.send(JSON.stringify({ type: 'tasks_get', agent: agentName }));
  });
}

function fetchCosts() {
  fetch('/costs').then(r => r.json()).then(({ costs, monthTotal }) => {
    let todayTotal = 0;
    costs.forEach(({ agent, today }) => {
      todayTotal += today;
      updateAgentCost(agent, today);
    });
    document.getElementById('today-cost').textContent = `Today: $${todayTotal.toFixed(2)}`;
    document.getElementById('month-cost').textContent = `Month: $${monthTotal.toFixed(2)}`;
  }).catch(() => {}); // silent fail — server may not be ready
  setTimeout(fetchCosts, 30_000);
}

// New Agent modal
document.getElementById('btn-new-agent').addEventListener('click', () => {
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modal-name').focus();
  const wdInput = document.getElementById('modal-workdir');
  if (!wdInput.value) {
    fetch('/config').then(r => r.json()).then(cfg => { wdInput.value = cfg.defaultWorkdir; }).catch(() => {});
  }
});
document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal').classList.add('hidden');
});
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal')) {
    document.getElementById('modal').classList.add('hidden');
  }
});
document.getElementById('modal-spawn').addEventListener('click', () => {
  const name = document.getElementById('modal-name').value.trim();
  const workdir = document.getElementById('modal-workdir').value.trim();
  if (!name || !workdir) return;
  const model = document.getElementById('modal-model').value;
  const isolate = document.getElementById('modal-isolate').checked;
  ws.send(JSON.stringify({
    type: 'spawn', agent: name, workdir,
    ...(model ? { model } : {}),
    ...(isolate ? { isolate: true } : {}),
  }));
  ensurePanel({ name, mode: 'spawn', status: 'running', isolate });
  document.getElementById('modal').classList.add('hidden');
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-workdir').value = '';
  document.getElementById('modal-isolate').checked = false;
});

// Refresh button
document.getElementById('btn-refresh').addEventListener('click', () => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'agents' }));
  fetchCosts();
});

// Resize terminals when window resizes
window.addEventListener('resize', () => {
  Object.values(terminals).forEach(({ fitAddon }) => fitAddon.fit());
});

async function populateModelDropdown() {
  try {
    const res = await fetch('/router/models');
    if (!res.ok) return; // router not running — leave default only
    const models = await res.json();
    if (models.error) return;
    const select = document.getElementById('modal-model');
    // Remove previously added optgroups (keep the first default option)
    while (select.options.length > 1) select.remove(1);
    for (const [provider, list] of Object.entries(models)) {
      const group = document.createElement('optgroup');
      group.label = provider;
      for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
  } catch {
    // router not running — dropdown stays at default only
  }
}

// ============================================================
// Projects tab
// ============================================================

let currentView = 'agents';

function showView(view) {
  currentView = view;
  const panels    = document.getElementById('panels');
  const toolbar   = document.getElementById('toolbar');
  const projView  = document.getElementById('project-view');
  const projBar   = document.getElementById('proj-toolbar');
  if (view === 'projects') {
    panels.style.display   = 'none';
    toolbar.style.display  = 'none';
    projView.classList.remove('hidden');
    if (projBar) projBar.style.display = 'flex';
    fetchProjects();
  } else {
    panels.style.display   = '';
    toolbar.style.display  = '';
    projView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
  }
}

async function fetchProjects() {
  try {
    const res = await fetch('/projects');
    const projects = await res.json();
    renderProjects(projects);
  } catch { /* silent fail */ }
}

function renderProjects(projects) {
  const view = document.getElementById('project-view');
  // Clear existing cards but keep the "New Project" button if injected
  view.innerHTML = `
    <div style="grid-column:1/-1;display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0;font-size:15px">Projects</h3>
      <button id="btn-new-project" style="background:#238636;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:13px">+ New Project</button>
    </div>
  `;
  document.getElementById('btn-new-project').addEventListener('click', openNewProjectModal);

  if (!projects.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'grid-column:1/-1;color:#8b949e;text-align:center;padding:40px';
    empty.textContent = 'No active projects. Create one to get started.';
    view.appendChild(empty);
    return;
  }

  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'project-card';
    const agentStr = p.agents.length ? p.agents.join(', ') : '(no agents)';
    const notesSnip = (p.notes || '').slice(0, 120) + ((p.notes || '').length > 120 ? '…' : '');
    card.innerHTML = `
      <div class="project-card-header">
        <span class="project-card-name">${escHtml(p.name)}</span>
        <span class="badge badge-${escHtml(p.status)}">${escHtml(p.status)}</span>
      </div>
      <div class="project-card-meta">Agents: ${escHtml(agentStr)}</div>
      <div class="project-card-meta">Week: $${p.costWeek.toFixed(4)} &nbsp; Month: $${p.costMonth.toFixed(4)}</div>
      ${notesSnip ? `<div class="project-card-notes">${escHtml(notesSnip)}</div>` : ''}
      <div class="project-card-footer">
        <button class="btn-edit" data-proj-id="${p.id}">Edit</button>
      </div>
    `;
    card.querySelector('[data-proj-id]').addEventListener('click', () => openEditProjectModal(p.id));
    view.appendChild(card);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- New Project modal ---
function openNewProjectModal() {
  document.getElementById('proj-modal-name').value = '';
  document.getElementById('proj-modal-notes').value = '';
  document.getElementById('proj-modal').classList.remove('hidden');
  document.getElementById('proj-modal-name').focus();
}

document.getElementById('proj-modal-cancel').addEventListener('click', () => {
  document.getElementById('proj-modal').classList.add('hidden');
});
document.getElementById('proj-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('proj-modal'))
    document.getElementById('proj-modal').classList.add('hidden');
});
document.getElementById('proj-modal-create').addEventListener('click', async () => {
  const name  = document.getElementById('proj-modal-name').value.trim();
  const notes = document.getElementById('proj-modal-notes').value.trim();
  if (!name) return;
  await fetch('/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, notes }),
  });
  document.getElementById('proj-modal').classList.add('hidden');
  fetchProjects();
});

// --- Edit Project modal ---
async function openEditProjectModal(projectId) {
  const res = await fetch(`/projects/${projectId}`);
  const p   = await res.json();

  document.getElementById('edit-proj-id').value      = p.id;
  document.getElementById('edit-proj-title').textContent = `Edit: ${p.name}`;
  document.getElementById('edit-proj-name').value    = p.name;
  document.getElementById('edit-proj-status').value  = p.status;
  document.getElementById('edit-proj-notes').value   = p.notes || '';
  document.getElementById('edit-proj-summary').textContent = p.last_summary || '(none)';

  // Linked agents
  const agentsDiv = document.getElementById('edit-proj-agents');
  agentsDiv.innerHTML = '';
  for (const agentName of p.agents) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:2px 0';
    row.innerHTML = `<span style="font-size:13px">${escHtml(agentName)}</span>
      <button style="background:none;border:none;color:#f85149;cursor:pointer;font-size:12px" data-unlink="${escHtml(agentName)}">×</button>`;
    row.querySelector('[data-unlink]').addEventListener('click', async () => {
      await fetch(`/projects/${p.id}/agents/${encodeURIComponent(agentName)}`, { method: 'DELETE' });
      openEditProjectModal(p.id);
    });
    agentsDiv.appendChild(row);
  }

  // Agent dropdown for linking
  const agentSelect = document.getElementById('edit-proj-agent-select');
  agentSelect.innerHTML = '<option value="">Select agent…</option>';
  try {
    const agentRes = await fetch('/agents');
    const agents   = await agentRes.json();
    for (const a of agents) {
      if (!p.agents.includes(a.name)) {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = a.name;
        agentSelect.appendChild(opt);
      }
    }
  } catch { /* agent list unavailable */ }

  document.getElementById('edit-proj-modal').classList.remove('hidden');
}

document.getElementById('edit-proj-cancel').addEventListener('click', () => {
  document.getElementById('edit-proj-modal').classList.add('hidden');
});
document.getElementById('edit-proj-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('edit-proj-modal'))
    document.getElementById('edit-proj-modal').classList.add('hidden');
});
document.getElementById('edit-proj-save').addEventListener('click', async () => {
  const id     = Number(document.getElementById('edit-proj-id').value);
  const name   = document.getElementById('edit-proj-name').value.trim();
  const status = document.getElementById('edit-proj-status').value;
  const notes  = document.getElementById('edit-proj-notes').value;
  if (!name) return;
  await fetch(`/projects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, status, notes }),
  });
  document.getElementById('edit-proj-modal').classList.add('hidden');
  fetchProjects();
});
document.getElementById('edit-proj-link-btn').addEventListener('click', async () => {
  const id        = Number(document.getElementById('edit-proj-id').value);
  const agentName = document.getElementById('edit-proj-agent-select').value;
  if (!agentName) return;
  await fetch(`/projects/${id}/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentName }),
  });
  openEditProjectModal(id);
});

// Projects tab button
document.getElementById('btn-projects').addEventListener('click', () => {
  if (currentView === 'projects') {
    showView('agents');
    document.getElementById('btn-projects').textContent = 'Projects';
  } else {
    showView('projects');
    document.getElementById('btn-projects').textContent = '← Agents';
  }
});

function showPRLink(agentName, prUrl, prNumber) {
  const headerRight = document.getElementById(`header-right-${escHtml(agentName)}`);
  if (!headerRight) return;
  headerRight.innerHTML = `
    <span class="panel-cost" id="cost-${escHtml(agentName)}">$0.00 today</span>
    <a class="btn-view-pr" href="${escHtml(prUrl)}" target="_blank" rel="noopener">View PR #${escHtml(String(prNumber))}</a>
    <span class="badge badge-pr-open" id="pr-badge-${escHtml(agentName)}">open</span>
  `;
}

function updatePRBadge(agentName, status) {
  const badge = document.getElementById(`pr-badge-${escHtml(agentName)}`);
  if (!badge) return;
  badge.textContent = status;
  badge.className = `badge badge-pr-${escHtml(status)}`;
}

function restoreKillButton(agentName) {
  const isolatedBadge = document.getElementById(`isolated-badge-${escHtml(agentName)}`);
  if (isolatedBadge) isolatedBadge.remove();
  const headerRight = document.getElementById(`header-right-${escHtml(agentName)}`);
  if (!headerRight) return;
  headerRight.innerHTML = `
    <span class="panel-cost" id="cost-${escHtml(agentName)}">$0.00 today</span>
    <button class="btn-kill" data-agent="${escHtml(agentName)}">Kill</button>
  `;
  headerRight.querySelector('.btn-kill').addEventListener('click', () => {
    ws.send(JSON.stringify({ type: 'kill', agent: agentName }));
  });
}

function showSuggestionsStrip() {
  document.getElementById('suggestions-strip').classList.remove('hidden');
}

function renderSuggestionCard(s) {
  const strip = document.getElementById('suggestions-strip');
  if (document.getElementById(`suggestion-${s.id}`)) return; // already rendered
  const date = (s.created_at ?? '').slice(11, 16);
  const card = document.createElement('div');
  card.className = `suggestion-card${s.status === 'noted' ? ' noted' : ''}`;
  card.id = `suggestion-${s.id}`;
  card.innerHTML = `
    <div class="suggestion-meta">
      <span>${escHtml(s.agent_name)} · ${escHtml(date)}</span>
      <div class="suggestion-actions">
        <button data-action="note" data-id="${s.id}">Noted</button>
        <button data-action="dismiss" data-id="${s.id}">Dismiss</button>
      </div>
    </div>
    <div class="suggestion-content">${escHtml(s.content)}</div>
  `;
  card.querySelector('[data-action="note"]').addEventListener('click', () => {
    fetch(`/suggestions/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'noted' }),
    }).then(() => card.classList.add('noted'));
  });
  card.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
    fetch(`/suggestions/${s.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'dismissed' }),
    }).then(() => {
      card.remove();
      if (!document.querySelector('.suggestion-card')) {
        document.getElementById('suggestions-strip').classList.add('hidden');
      }
    });
  });
  strip.appendChild(card);
}

function fetchSuggestions() {
  fetch('/suggestions')
    .then(r => r.json())
    .then(list => {
      if (!list.length) return;
      list.forEach(s => renderSuggestionCard(s));
      showSuggestionsStrip();
    })
    .catch(() => {});
  setTimeout(fetchSuggestions, 30_000);
}

connect();
