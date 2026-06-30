'use strict';

const WS_URL = `ws://${location.host}/ws`;

let ws;
const terminals = {};   // agentName → { term, fitAddon }
const taskContent = {}; // agentName → latest raw markdown content
const orchAgents = {}; // agentName → orchId

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

      case 'queue_task_added':
      case 'queue_task_assigned':
      case 'queue_task_done':
        if (currentView === 'queue') fetchAndRenderQueue(queueFilter);
        break;

      case 'orchestration_started':
        orchAgents[msg.agentName] = msg.id;
        // Panel may already exist (ensurePanel from agents list); add orch badge if so
        addOrchBadge(msg.agentName);
        break;
    }
  });

  ws.addEventListener('close', () => setTimeout(connect, 2000));
}

function ensurePanel({ name, mode, status, isolate, runtime, role }) {
  if (document.getElementById(`panel-${name}`)) return;

  const runtimeBadge = (runtime && runtime !== 'claude')
    ? `<span class="badge badge-vibe" id="runtime-badge-${escHtml(name)}">vibe</span>`
    : '';
  const roleBadge = role === 'orchestrator'
    ? `<span class="badge badge-orch" id="role-badge-${escHtml(name)}">orch</span>`
    : role === 'worker'
    ? `<span class="badge badge-worker" id="role-badge-${escHtml(name)}">worker</span>`
    : '';

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.id = `panel-${name}`;
  panel.innerHTML = `
    <div class="panel-header">
      <div style="display:flex;align-items:center;gap:0">
        <span class="panel-name">${escHtml(name)}</span>
        <span class="badge badge-${status}" id="badge-${escHtml(name)}">${status}</span>
        ${mode === 'observe' ? '<span class="badge badge-observe">observe</span>' : ''}
        ${runtimeBadge}${roleBadge}
        ${isolate ? `<span class="badge badge-isolated" id="isolated-badge-${escHtml(name)}">isolated</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px" id="header-right-${name}">
        <span class="panel-cost" id="cost-${name}">$0.00 today</span>
        <button class="btn-clear-tasks" data-agent="${name}">Clear tasks</button>
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

  // Clear tasks button
  panel.querySelector('.btn-clear-tasks').addEventListener('click', async () => {
    if (!confirm(`Clear all tasks for ${name}?`)) return;
    await fetch(`/tasks/${encodeURIComponent(name)}`, { method: 'DELETE' });
  });

  // Add task button + Enter key
  const taskInput = panel.querySelector('.task-add input');
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
    // Replace Kill with Restart + Remove
    const cost = headerRight.querySelector('.panel-cost')?.outerHTML ?? `<span class="panel-cost" id="cost-${name}">$0.00 today</span>`;
    headerRight.innerHTML = `
      ${cost}
      <button class="btn-restart" id="restart-${name}">Restart</button>
      <button class="btn-remove" id="remove-${name}">Remove</button>
    `;
    document.getElementById(`restart-${name}`)?.addEventListener('click', () => {
      fetch(`/agents/${encodeURIComponent(name)}`)
        .then(r => r.json())
        .then(agent => {
          ws.send(JSON.stringify({
            type: 'spawn', agent: agent.name, workdir: agent.workdir, runtime: agent.runtime ?? 'claude',
            ...(agent.model && agent.runtime !== 'vibe' ? { model: agent.model } : {}),
          }));
        })
        .catch(err => console.error('Restart failed:', err));
    });
    document.getElementById(`remove-${name}`)?.addEventListener('click', () => {
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

// Workspace helpers
function loadWorkspaceDropdown() {
  return fetch('/workspaces').then(r => r.json()).then(list => {
    const sel = document.getElementById('modal-workspace');
    sel.innerHTML = '<option value="">— manual entry —</option>';
    list.forEach(ws => {
      const opt = document.createElement('option');
      opt.value = ws.path;
      opt.textContent = `${ws.name}  (${ws.path})`;
      sel.appendChild(opt);
    });
  }).catch(() => {});
}

document.getElementById('modal-workspace').addEventListener('change', e => {
  if (e.target.value) document.getElementById('modal-workdir').value = e.target.value;
});

// New Agent modal
document.getElementById('btn-new-agent').addEventListener('click', () => {
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modal-name').focus();
  loadWorkspaceDropdown();
  const wdInput = document.getElementById('modal-workdir');
  if (!wdInput.value) {
    fetch('/config').then(r => r.json()).then(cfg => { wdInput.value = cfg.defaultWorkdir; }).catch(() => {});
  }
  fetch('/api/specialists')
    .then(r => r.json())
    .then(specialists => {
      const sel = document.getElementById('modal-specialist');
      sel.innerHTML = '<option value="">— none —</option>';
      specialists.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = s.label;
        sel.appendChild(opt);
      });
    })
    .catch(() => {});
});
document.getElementById('modal-cancel').addEventListener('click', () => {
  document.getElementById('modal').classList.add('hidden');
});
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal')) {
    document.getElementById('modal').classList.add('hidden');
  }
});
document.getElementById('modal-runtime').addEventListener('change', e => {
  const runtime = e.target.value;
  const modelGroup = document.getElementById('modal-model-group');
  modelGroup.style.display = runtime === 'vibe' ? 'none' : '';
  filterModelDropdownForRuntime(runtime);
});

function filterModelDropdownForRuntime(runtime) {
  const select = document.getElementById('modal-model');
  if (!select) return;
  for (const group of select.querySelectorAll('optgroup')) {
    const provider = group.label;
    // For claude/gemini/mistral/ollama runtimes: hide openrouter group
    // For openrouter runtime: hide all non-openrouter groups
    if (runtime === 'openrouter') {
      group.style.display = provider === 'openrouter' ? '' : 'none';
    } else {
      group.style.display = provider === 'openrouter' ? 'none' : '';
    }
  }
  // Auto-select first visible option
  const first = select.querySelector('optgroup:not([style*="none"]) option');
  if (first) select.value = first.value;
}

document.getElementById('modal-spawn').addEventListener('click', () => {
  const name = document.getElementById('modal-name').value.trim();
  const workdir = document.getElementById('modal-workdir').value.trim();
  if (!name || !workdir) return;
  const model = document.getElementById('modal-model').value;
  const isolate = document.getElementById('modal-isolate').checked;
  const runtime = document.getElementById('modal-runtime').value || 'claude';
  const specialistName = document.getElementById('modal-specialist')?.value || undefined;
  const role = document.getElementById('modal-role')?.value.trim() || undefined;
  ws.send(JSON.stringify({
    type: 'spawn', agent: name, workdir, runtime,
    ...(model && runtime !== 'vibe' ? { model } : {}),
    ...(isolate ? { isolate: true } : {}),
    ...(specialistName ? { specialistName } : {}),
    ...(role ? { role } : {}),
  }));
  ensurePanel({ name, mode: 'spawn', status: 'running', isolate, runtime });
  document.getElementById('modal').classList.add('hidden');
  document.getElementById('modal-name').value = '';
  document.getElementById('modal-workdir').value = '';
  document.getElementById('modal-isolate').checked = false;
  document.getElementById('modal-runtime').value = 'claude';
  filterModelDropdownForRuntime('claude');
  document.getElementById('modal-specialist').value = '';
  document.getElementById('modal-role').value = '';
  document.getElementById('modal-model-group').style.display = '';
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
  const panels          = document.getElementById('panels');
  const toolbar         = document.getElementById('toolbar');
  const projView        = document.getElementById('project-view');
  const projBar         = document.getElementById('proj-toolbar');
  const queueView       = document.getElementById('queue-view');
  const skillsView      = document.getElementById('skills-view');
  const specialistsView = document.getElementById('specialists-view');

  if (view === 'projects') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.remove('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.add('hidden');
    specialistsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'flex';
    fetchProjects();
  } else if (view === 'queue') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.add('hidden');
    queueView.classList.remove('hidden');
    skillsView.classList.add('hidden');
    specialistsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
    fetchAndRenderQueue();
  } else if (view === 'skills') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.add('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.remove('hidden');
    specialistsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
    fetchAndRenderSkills();
  } else if (view === 'specialists') {
    panels.style.display = 'none';
    toolbar.style.display = 'none';
    projView.classList.add('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.add('hidden');
    specialistsView.classList.remove('hidden');
    if (projBar) projBar.style.display = 'none';
    fetchAndRenderSpecialists();
  } else {
    panels.style.display = '';
    toolbar.style.display = '';
    projView.classList.add('hidden');
    queueView.classList.add('hidden');
    skillsView.classList.add('hidden');
    specialistsView.classList.add('hidden');
    if (projBar) projBar.style.display = 'none';
  }
}

async function fetchProjects() {
  try {
    const res = await fetch('/projects');
    const projects = await res.json();
    renderProjects(projects);
    await Promise.all(projects.map(async p => {
      try {
        const r = await fetch(`/api/projects/${p.id}/docs`);
        const docs = await r.json();
        const btn = document.querySelector(`.btn-docs[data-proj-id="${p.id}"]`);
        if (btn) btn.textContent = `📄 Docs (${docs.length})`;
      } catch { /* silent fail */ }
    }));
  } catch { /* silent fail */ }
}

function renderProjects(projects) {
  const view = document.getElementById('project-view');
  // Clear existing cards but keep the "New Project" button if injected
  view.innerHTML = `
    <div style="grid-column:1/-1;display:flex;justify-content:space-between;align-items:center">
      <h3 style="margin:0;font-size:18px">Projects</h3>
      <button id="btn-new-project" style="background:#238636;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:16px">+ New Project</button>
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
        <button class="btn-docs" data-proj-id="${p.id}">📄 Docs</button>
        <button class="btn-edit" data-proj-id="${p.id}">Edit</button>
      </div>
    `;
    card.querySelector('.btn-edit').addEventListener('click', () => openEditProjectModal(p.id));
    card.querySelector('.btn-docs').addEventListener('click', () => openDocsModal(p.id, p.name));
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
    row.innerHTML = `<span style="font-size:16px">${escHtml(agentName)}</span>
      <button style="background:none;border:none;color:#f85149;cursor:pointer;font-size:14px" data-unlink="${escHtml(agentName)}">×</button>`;
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

// --- Project docs modal ---

let _docsProjectId = null;

async function openDocsModal(projectId, projectName) {
  _docsProjectId = projectId;
  document.getElementById('proj-docs-title').textContent = `Docs — ${projectName}`;
  document.getElementById('proj-docs-modal').classList.remove('hidden');
  await _refreshDocsList();
}

async function _refreshDocsList() {
  const list = document.getElementById('proj-docs-list');
  list.innerHTML = '<span style="color:#8b949e;font-size:13px">Loading…</span>';
  try {
    const r = await fetch(`/api/projects/${_docsProjectId}/docs`);
    const docs = await r.json();
    if (!docs.length) {
      list.innerHTML = '<span style="color:#8b949e;font-size:13px">No documents yet. Upload a PRD, BRD, or design doc.</span>';
      return;
    }
    list.innerHTML = '';
    for (const doc of docs) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#0d1117;border:1px solid #30363d;border-radius:6px';
      const date = new Date(doc.created_at * 1000).toLocaleDateString();
      const badge = doc.source === 'agent'
        ? '<span style="font-size:11px;padding:1px 6px;border-radius:3px;background:#21262d;color:#8b949e">agent</span>'
        : '<span style="font-size:11px;padding:1px 6px;border-radius:3px;background:#21262d;color:#8b949e">upload</span>';
      row.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:3px">
          <span style="font-weight:600;font-size:14px">${escHtml(doc.title)}</span>
          <span style="font-size:12px;color:#8b949e">${badge} &nbsp; ${date}</span>
        </div>
        <button data-del-doc-id="${doc.id}" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:18px;padding:0 4px" title="Delete document">🗑</button>
      `;
      row.querySelector('[data-del-doc-id]').addEventListener('click', async () => {
        await fetch(`/api/projects/${_docsProjectId}/docs/${doc.id}`, { method: 'DELETE' });
        await _refreshDocsList();
      });
      list.appendChild(row);
    }
  } catch {
    list.innerHTML = '<span style="color:#f85149;font-size:13px">Failed to load documents.</span>';
  }
}

document.getElementById('proj-docs-close').addEventListener('click', () => {
  document.getElementById('proj-docs-modal').classList.add('hidden');
  fetchProjects();
});

document.getElementById('proj-docs-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('proj-docs-modal')) {
    document.getElementById('proj-docs-modal').classList.add('hidden');
    fetchProjects();
  }
});

document.getElementById('proj-docs-upload-btn').addEventListener('click', () => {
  document.getElementById('proj-docs-file-input').value = '';
  document.getElementById('proj-docs-file-input').click();
});

document.getElementById('proj-docs-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const title = file.name;
  const isPdf = file.name.toLowerCase().endsWith('.pdf');
  const isMd  = file.name.toLowerCase().endsWith('.md');

  const content = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = ev => resolve(ev.target.result);
    reader.onerror = reject;
    if (isPdf) reader.readAsDataURL(file);
    else       reader.readAsText(file);
  });

  const mimeType = isPdf ? 'application/pdf' : (isMd ? 'text/markdown' : 'text/plain');

  const r = await fetch(`/api/projects/${_docsProjectId}/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content, mimeType, source: 'upload' }),
  });

  if (r.ok) {
    await _refreshDocsList();
    fetchProjects();
  } else {
    const err = await r.json().catch(() => ({}));
    alert(`Upload failed: ${err.error ?? 'unknown error'}`);
  }
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

document.getElementById('btn-agents-home').addEventListener('click', () => {
  showView('agents');
  document.getElementById('btn-projects').textContent = 'Projects';
});

function showPRLink(agentName, prUrl, prNumber) {
  const headerRight = document.getElementById(`header-right-${escHtml(agentName)}`);
  if (!headerRight) return;
  headerRight.innerHTML = `
    <span class="panel-cost" id="cost-${escHtml(agentName)}">$0.00 today</span>
    <a class="btn-view-pr" href="${escHtml(prUrl)}" target="_blank" rel="noopener">View PR #${escHtml(String(prNumber))}</a>
    <button class="btn-diff" id="diff-btn-${escHtml(agentName)}">Diff</button>
    <span class="badge badge-pr-open" id="pr-badge-${escHtml(agentName)}">open</span>
    <button class="btn-discard" id="discard-pr-${escHtml(agentName)}">Discard</button>
  `;
  document.getElementById(`discard-pr-${escHtml(agentName)}`)?.addEventListener('click', () => {
    fetch(`/worktrees/${encodeURIComponent(agentName)}`, { method: 'DELETE' })
      .then(() => restoreKillButton(agentName))
      .catch(err => console.error('Discard failed:', err));
  });
  document.getElementById(`diff-btn-${escHtml(agentName)}`)?.addEventListener('click', () => openDiffModal(agentName));
}

function openDiffModal(agentName) {
  document.getElementById('diff-modal-title').textContent = `Diff — ${agentName}`;
  document.getElementById('diff-stat').textContent = 'Loading…';
  document.getElementById('diff-content').innerHTML = '';
  document.getElementById('diff-modal').classList.remove('hidden');

  fetch(`/diffs/${encodeURIComponent(agentName)}`)
    .then(r => r.json())
    .then(({ branch, stat, diff }) => {
      document.getElementById('diff-modal-title').textContent = `Diff — ${agentName} (${branch})`;
      document.getElementById('diff-stat').textContent = stat || '(no changes)';
      // Colour diff lines
      const lines = (diff || '(empty diff)').split('\n').map(line => {
        const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        if (line.startsWith('+++') || line.startsWith('---')) return `<span style="color:#e6edf3;font-weight:bold">${esc}</span>`;
        if (line.startsWith('+')) return `<span style="color:#3fb950">${esc}</span>`;
        if (line.startsWith('-')) return `<span style="color:#f85149">${esc}</span>`;
        if (line.startsWith('@@')) return `<span style="color:#79c0ff">${esc}</span>`;
        if (line.startsWith('diff ') || line.startsWith('index ')) return `<span style="color:#8b949e">${esc}</span>`;
        return esc;
      });
      document.getElementById('diff-content').innerHTML = lines.join('\n');
    })
    .catch(err => {
      document.getElementById('diff-stat').textContent = '';
      document.getElementById('diff-content').textContent = `Error: ${err.message}`;
    });
}

document.getElementById('diff-modal-close').addEventListener('click', () => {
  document.getElementById('diff-modal').classList.add('hidden');
});
document.getElementById('diff-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('diff-modal')) document.getElementById('diff-modal').classList.add('hidden');
});

// --- Workspace manager ---
function renderWorkspaceList(list) {
  const container = document.getElementById('ws-list');
  if (!list.length) { container.innerHTML = '<span style="color:#8b949e;font-size:14px">No workspaces registered yet.</span>'; return; }
  container.innerHTML = list.map(ws => `
    <div style="display:flex;align-items:center;gap:8px;background:#161b22;padding:8px 10px;border-radius:6px;border:1px solid #30363d">
      <span style="font-weight:600;font-size:16px;color:#e6edf3;min-width:120px">${escHtml(ws.name)}</span>
      <span style="color:#8b949e;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(ws.path)}</span>
      <button class="btn-remove ws-del-btn" data-id="${ws.id}" style="flex-shrink:0">Remove</button>
    </div>
  `).join('');
  container.querySelectorAll('.ws-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      fetch(`/workspaces/${btn.dataset.id}`, { method: 'DELETE' })
        .then(() => fetch('/workspaces').then(r => r.json()).then(renderWorkspaceList))
        .catch(err => console.error('Remove workspace failed:', err));
    });
  });
}

document.getElementById('btn-workspaces').addEventListener('click', () => {
  document.getElementById('ws-modal').classList.remove('hidden');
  fetch('/workspaces').then(r => r.json()).then(renderWorkspaceList).catch(() => {});
});

document.getElementById('ws-modal-close').addEventListener('click', () => {
  document.getElementById('ws-modal').classList.add('hidden');
});

document.getElementById('ws-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('ws-modal')) document.getElementById('ws-modal').classList.add('hidden');
});

document.getElementById('ws-add-btn').addEventListener('click', () => {
  const name = document.getElementById('ws-add-name').value.trim();
  const path = document.getElementById('ws-add-path').value.trim();
  if (!name || !path) return;
  fetch('/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path }),
  })
    .then(r => r.json())
    .then(() => {
      document.getElementById('ws-add-name').value = '';
      document.getElementById('ws-add-path').value = '';
      return fetch('/workspaces').then(r => r.json()).then(renderWorkspaceList);
    })
    .catch(err => console.error('Add workspace failed:', err));
});

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

// ============================================================
// MCP Servers modal
// ============================================================

async function renderMcpList() {
  const list = await fetch('/mcp/servers').then(r => r.json()).catch(() => []);
  const container = document.getElementById('mcp-list');
  if (!list.length) {
    container.innerHTML = '<p style="color:#8b949e;font-size:14px;margin:0">No MCP servers configured yet.</p>';
    return;
  }
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="color:#8b949e;text-align:left">
        <th style="padding:4px 8px">Name</th><th style="padding:4px 8px">Command + Args</th>
        <th style="padding:4px 8px">Scope</th><th style="padding:4px 8px">On</th><th></th>
      </tr></thead>
      <tbody>${list.map(s => {
        const argsStr = s.args.join(' ');
        return `<tr style="border-top:1px solid #21262d">
          <td style="padding:4px 8px">${escHtml(s.name)}</td>
          <td style="padding:4px 8px;color:#8b949e;font-size:13px">${escHtml(s.command)} ${escHtml(argsStr)}</td>
          <td style="padding:4px 8px">${escHtml(s.scope)}</td>
          <td style="padding:4px 8px"><input type="checkbox" data-mcp-toggle="${s.id}" ${s.enabled ? 'checked' : ''}></td>
          <td style="padding:4px 8px"><button class="btn-remove" data-mcp-delete="${s.id}">Remove</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  `;
  container.querySelectorAll('[data-mcp-toggle]').forEach(cb => {
    cb.addEventListener('change', () => fetch(`/mcp/servers/${cb.dataset.mcpToggle}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: cb.checked ? 1 : 0 }),
    }));
  });
  container.querySelectorAll('[data-mcp-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/mcp/servers/${btn.dataset.mcpDelete}`, { method: 'DELETE' });
      renderMcpList();
    });
  });
}

async function populateMcpScopeDropdown() {
  const agents = await fetch('/agents').then(r => r.json()).catch(() => []);
  const sel = document.getElementById('mcp-add-scope');
  sel.innerHTML = '<option value="global">Global (all agents)</option>';
  agents.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.name; opt.textContent = `Agent: ${a.name}`;
    sel.appendChild(opt);
  });
}

document.getElementById('btn-mcp').addEventListener('click', () => {
  document.getElementById('mcp-modal').classList.remove('hidden');
  renderMcpList();
  populateMcpScopeDropdown();
});
document.getElementById('mcp-modal-close').addEventListener('click', () =>
  document.getElementById('mcp-modal').classList.add('hidden'));
document.getElementById('mcp-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('mcp-modal'))
    document.getElementById('mcp-modal').classList.add('hidden');
});

document.getElementById('mcp-add-btn').addEventListener('click', async () => {
  const name    = document.getElementById('mcp-add-name').value.trim();
  const command = document.getElementById('mcp-add-command').value.trim();
  const argsStr = document.getElementById('mcp-add-args').value.trim();
  const envStr  = document.getElementById('mcp-add-env').value.trim();
  const scope   = document.getElementById('mcp-add-scope').value;
  if (!name || !command) return;
  const args = argsStr ? argsStr.split(/\s+/) : [];
  const env = {};
  envStr.split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
  await fetch('/mcp/servers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, command, args, env, scope }),
  });
  document.getElementById('mcp-add-name').value = '';
  document.getElementById('mcp-add-command').value = '';
  document.getElementById('mcp-add-args').value = '';
  document.getElementById('mcp-add-env').value = '';
  renderMcpList();
});

// ============================================================
// Task Queue tab
// ============================================================

let queueFilter = 'all';

document.getElementById('btn-queue').addEventListener('click', () => showView('queue'));

// ============================================================
// Skills Library tab
// ============================================================

document.getElementById('btn-skills').addEventListener('click', () => showView('skills'));

async function fetchAndRenderSkills() {
  const skills = await fetch('/api/skills').then(r => r.json()).catch(() => []);
  renderSkillsView(skills);
}

function renderSkillsView(skills) {
  const view = document.getElementById('skills-view');
  view.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <h2 style="margin:0;flex:1">Skills Library</h2>
      <button id="btn-skill-new" style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:15px">+ New Skill</button>
      <button id="btn-skill-import" style="background:none;border:1px solid #30363d;color:#e6edf3;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:15px">⬇ Import from GitHub</button>
      <button id="btn-skills-back" style="background:none;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:14px">← Dashboard</button>
    </div>
    <div id="skills-list" style="display:flex;flex-direction:column;gap:8px"></div>
  `;

  document.getElementById('btn-skills-back').addEventListener('click', () => showView('agents'));
  document.getElementById('btn-skill-new').addEventListener('click', openNewSkillModal);
  document.getElementById('btn-skill-import').addEventListener('click', openImportGitHubModal);

  const list = document.getElementById('skills-list');
  if (!skills.length) {
    list.innerHTML = '<p style="color:#8b949e">No skills yet. Add one manually or import from GitHub.</p>';
    return;
  }

  for (const skill of skills) {
    const card = document.createElement('div');
    card.className = 'skill-card';
    const tagsHtml = skill.tags
      ? skill.tags.split(',').filter(Boolean).map(t => `<span class="skill-tag">${escHtml(t.trim())}</span>`).join('')
      : '';
    card.innerHTML = `
      <div class="skill-card-header" data-id="${skill.id}" style="cursor:pointer">
        <span class="skill-name">${escHtml(skill.name)}</span>
        <span class="skill-badge" title="${escHtml(skill.source)}">${escHtml(skill.source)}</span>
        <div class="skill-actions">
          <button class="btn-skill-edit" data-id="${skill.id}" style="background:none;border:none;color:#58a6ff;cursor:pointer;font-size:14px;padding:2px 6px">Edit</button>
          <button class="btn-skill-delete" data-id="${skill.id}" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:14px;padding:2px 6px">Delete</button>
        </div>
      </div>
      <div style="color:#8b949e;font-size:14px;margin:4px 0">${escHtml(skill.description)}</div>
      ${tagsHtml ? `<div class="skill-tags">${tagsHtml}</div>` : ''}
      <div id="skill-content-${skill.id}" class="skill-content hidden"></div>
    `;
    list.appendChild(card);
  }

  list.querySelectorAll('.skill-card-header').forEach(header => {
    header.addEventListener('click', async (e) => {
      if (e.target.classList.contains('btn-skill-edit') || e.target.classList.contains('btn-skill-delete')) return;
      const id = header.dataset.id;
      const contentEl = document.getElementById(`skill-content-${id}`);
      if (!contentEl.classList.contains('hidden')) {
        contentEl.classList.add('hidden');
        return;
      }
      if (!contentEl.dataset.loaded) {
        const full = await fetch(`/api/skills/${id}`).then(r => r.json());
        contentEl.innerHTML = `<pre style="margin:0;white-space:pre-wrap;word-break:break-word">${escHtml(full.content)}</pre>`;
        contentEl.dataset.loaded = '1';
      }
      contentEl.classList.remove('hidden');
    });
  });

  list.querySelectorAll('.btn-skill-edit').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const full = await fetch(`/api/skills/${btn.dataset.id}`).then(r => r.json());
      openEditSkillModal(full);
    });
  });

  list.querySelectorAll('.btn-skill-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const skillName = btn.closest('.skill-card').querySelector('.skill-name').textContent;
      if (!confirm(`Delete skill "${skillName}"?`)) return;
      await fetch(`/api/skills/${btn.dataset.id}`, { method: 'DELETE' });
      fetchAndRenderSkills();
    });
  });
}

// --- New Skill / Edit Skill Modal ---

let _editingSkillId = null;

function openNewSkillModal() {
  _editingSkillId = null;
  document.getElementById('skill-modal-title').textContent = 'New Skill';
  ['skill-modal-name', 'skill-modal-desc', 'skill-modal-tags', 'skill-modal-content']
    .forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('skill-modal').classList.remove('hidden');
}

function openEditSkillModal(skill) {
  _editingSkillId = skill.id;
  document.getElementById('skill-modal-title').textContent = 'Edit Skill';
  document.getElementById('skill-modal-name').value    = skill.name;
  document.getElementById('skill-modal-desc').value    = skill.description;
  document.getElementById('skill-modal-tags').value    = skill.tags;
  document.getElementById('skill-modal-content').value = skill.content;
  document.getElementById('skill-modal').classList.remove('hidden');
}

document.getElementById('skill-modal-cancel').addEventListener('click', () =>
  document.getElementById('skill-modal').classList.add('hidden'));

document.getElementById('skill-modal-save').addEventListener('click', async () => {
  const name        = document.getElementById('skill-modal-name').value.trim();
  const description = document.getElementById('skill-modal-desc').value.trim();
  const tags        = document.getElementById('skill-modal-tags').value.trim();
  const content     = document.getElementById('skill-modal-content').value.trim();
  if (!name || !description || !content) return;

  if (_editingSkillId) {
    await fetch(`/api/skills/${_editingSkillId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, tags, content }),
    });
  } else {
    await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, tags, content }),
    });
  }
  document.getElementById('skill-modal').classList.add('hidden');
  fetchAndRenderSkills();
});

// --- Import from GitHub Modal ---

function openImportGitHubModal() {
  document.getElementById('skill-import-url').value     = '';
  document.getElementById('skill-import-result').textContent = '';
  document.getElementById('skill-import-result').style.color = '';
  document.getElementById('skill-import-modal').classList.remove('hidden');
}

document.getElementById('skill-import-cancel').addEventListener('click', () =>
  document.getElementById('skill-import-modal').classList.add('hidden'));

document.getElementById('skill-import-btn').addEventListener('click', async () => {
  const url = document.getElementById('skill-import-url').value.trim();
  if (!url) return;
  const resultEl = document.getElementById('skill-import-result');
  resultEl.textContent = 'Importing…';
  resultEl.style.color = '#8b949e';
  try {
    const r = await fetch('/api/skills/import-github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) {
      resultEl.style.color = '#f85149';
      resultEl.textContent = data.error || 'Import failed';
    } else {
      resultEl.style.color = '#3fb950';
      resultEl.textContent = `Imported ${data.imported}, updated ${data.updated}, skipped ${data.skipped}`;
      if (data.imported + data.updated > 0) fetchAndRenderSkills();
    }
  } catch {
    resultEl.style.color = '#f85149';
    resultEl.textContent = 'Network error';
  }
});

async function fetchAndRenderQueue(statusFilter = queueFilter) {
  const url = statusFilter === 'all' ? '/queue/tasks' : `/queue/tasks?status=${statusFilter}`;
  const tasks = await fetch(url).then(r => r.json()).catch(() => []);
  const agents = await fetch('/agents').then(r => r.json()).catch(() => []);
  renderQueueView(tasks, agents, statusFilter);
  fetchHeartbeatLog();
  // Populate default agent config
  fetch('/queue/config')
    .then(r => r.json())
    .then(cfg => {
      const input = document.getElementById('queue-default-agent');
      if (input) input.value = cfg.defaultAgent ?? '';
    })
    .catch(() => {});
}

async function fetchHeartbeatLog() {
  try {
    const entries = await fetch('/heartbeat/log?limit=10').then(r => r.json());
    const container = document.getElementById('hb-log-entries');
    if (!container) return;
    if (!entries.length) {
      container.innerHTML = '<div class="hb-entry"><div class="hb-note" style="color:#8b949e">No heartbeat cycles run yet.</div></div>';
      return;
    }
    container.innerHTML = entries.map(e => {
      const actions = JSON.parse(e.actions_json || '[]');
      const actionsHtml = actions.length ? `<div class="hb-actions">Actions: ${actions.map(a => escHtml(a.type) + (a.title ? ': ' + escHtml(a.title) : '')).join(', ')}</div>` : '';
      return `<div class="hb-entry">
        <div class="hb-note">${escHtml(e.note)}</div>
        ${actionsHtml}
        <div class="hb-meta">${new Date(e.created_at).toLocaleString()}</div>
      </div>`;
    }).join('');
  } catch {}
}

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function renderQueueView(tasks, agents, activeFilter) {
  const view = document.getElementById('queue-view');
  const roleChip = r => r ? `<span class="role-chip role-${escHtml(r)}">${escHtml(r)}</span>` : '';
  const statusBadge = s => `<span class="badge badge-queue-${escHtml(s)}">${escHtml(s.replace('_', ' '))}</span>`;
  const agentCell = t => t.assigned_to
    ? escHtml(t.assigned_to)
    : `<span style="color:#d29922">unassigned</span>`;

  view.innerHTML = `
    <div class="queue-header">
      <button id="btn-queue-back" style="background:none;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:14px">← Dashboard</button>
      <h3 style="margin:0;font-size:18px">Task Queue</h3>
      <button id="btn-add-task" style="background:#238636;border:none;color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:16px">+ Add Task</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0 10px;border-bottom:1px solid #30363d;margin-bottom:8px;font-size:13px;color:#8b949e">
      <span>Default agent (roleless tasks):</span>
      <input id="queue-default-agent" type="text" placeholder="agent name or leave blank to skip"
        style="background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:3px 8px;border-radius:4px;font-size:13px;width:220px">
      <button id="btn-save-default-agent" style="background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:13px">Save</button>
    </div>
    <div class="queue-filters">
      ${['all','pending','in_progress','done','cancelled'].map(f =>
        `<button class="filter-pill${activeFilter === f ? ' active' : ''}" data-filter="${escHtml(f)}">${escHtml(f === 'in_progress' ? 'in progress' : f)}</button>`
      ).join('')}
    </div>
    ${tasks.length === 0
      ? `<p style="color:#8b949e;text-align:center;padding:40px">No tasks${activeFilter !== 'all' ? ` with status "${escHtml(activeFilter)}"` : ''}.</p>`
      : `<table class="queue-table">
          <thead><tr>
            <th>Status</th><th>Title</th><th>Role</th><th>Agent</th><th>Pri</th><th>Created</th><th></th>
          </tr></thead>
          <tbody>${tasks.map(t => `
            <tr class="queue-row${!t.assigned_to ? ' queue-row-unassigned' : ''}" data-task-id="${escHtml(String(t.id))}">
              <td>${statusBadge(t.status)}</td>
              <td style="cursor:pointer" class="queue-title-cell" data-expand="${escHtml(String(t.id))}">${escHtml(t.title)}</td>
              <td>${roleChip(t.role)}</td>
              <td>${agentCell(t)}</td>
              <td style="color:#8b949e">${escHtml(String(t.priority))}</td>
              <td style="color:#8b949e;white-space:nowrap">${escHtml(relativeTime(t.created_at))}</td>
              <td style="white-space:nowrap">
                ${!t.assigned_to && t.status === 'pending' ? `<button class="btn-assign-task" data-id="${escHtml(String(t.id))}" style="font-size:13px;padding:2px 7px;border-radius:4px;border:1px solid #388bfd;background:none;color:#388bfd;cursor:pointer">Assign</button>` : ''}
                ${['pending','in_progress'].includes(t.status) ? `<button class="btn-cancel-task" data-id="${escHtml(String(t.id))}" style="font-size:13px;padding:2px 7px;border-radius:4px;border:1px solid #f8514966;background:none;color:#f85149;cursor:pointer;margin-left:4px">Cancel</button>` : ''}
              </td>
            </tr>
            <tr class="queue-expand" id="expand-${escHtml(String(t.id))}"><td colspan="7">
              ${t.description ? `<strong>Description:</strong> ${escHtml(t.description)}\n` : ''}
              ${t.result ? `<strong>Result:</strong> ${escHtml(t.result)}` : '(no result yet)'}
            </td></tr>
          `).join('')}</tbody>
        </table>`
    }
    <div class="heartbeat-log" id="heartbeat-log-panel">
      <h3>Flint Heartbeat <button class="hb-trigger" id="btn-hb-trigger">Run now</button></h3>
      <div id="hb-log-entries"></div>
    </div>
  `;

  // Back button
  document.getElementById('btn-queue-back').addEventListener('click', () => showView('agents'));

  // Heartbeat trigger button
  document.getElementById('btn-hb-trigger')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-hb-trigger');
    if (btn) btn.disabled = true;
    try {
      await fetch('/heartbeat/trigger', { method: 'POST' });
      await fetchHeartbeatLog();
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Filter pills
  view.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      queueFilter = btn.dataset.filter;
      fetchAndRenderQueue(queueFilter);
    });
  });

  // Expand rows
  view.querySelectorAll('.queue-title-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const row = document.getElementById(`expand-${cell.dataset.expand}`);
      row?.classList.toggle('open');
    });
  });

  // Cancel buttons
  view.querySelectorAll('.btn-cancel-task').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/queue/tasks/${btn.dataset.id}`, { method: 'DELETE' });
      fetchAndRenderQueue(queueFilter);
    });
  });

  // Assign buttons — open add-task modal pre-filled
  view.querySelectorAll('.btn-assign-task').forEach(btn => {
    btn.addEventListener('click', () => {
      openAddTaskModal(agents, Number(btn.dataset.id));
    });
  });

  // Add Task button
  document.getElementById('btn-add-task').addEventListener('click', () => openAddTaskModal(agents));

  // Save default agent config
  document.getElementById('btn-save-default-agent')?.addEventListener('click', () => {
    const val = document.getElementById('queue-default-agent')?.value.trim() ?? '';
    fetch('/queue/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAgent: val }),
    }).catch(() => {});
  });
}

function openAddTaskModal(agents, preAssignTaskId = null) {
  const modal = document.getElementById('add-task-modal');
  const agentSel = document.getElementById('add-task-agent');
  agentSel.innerHTML = '<option value="">Leave unassigned</option>';
  agents.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.name; opt.textContent = a.name;
    agentSel.appendChild(opt);
  });
  modal.dataset.preAssignId = preAssignTaskId ?? '';
  // When assigning, clear stale form fields and update heading
  if (preAssignTaskId) {
    document.getElementById('add-task-title').value = '';
    document.getElementById('add-task-desc').value = '';
    document.getElementById('add-task-priority').value = '0';
    // Update heading to indicate assign mode
    const heading = modal.querySelector('h2');
    if (heading) heading.textContent = 'Assign Task to Agent';
  } else {
    const heading = modal.querySelector('h2');
    if (heading) heading.textContent = 'Add Task to Queue';
  }
  modal.classList.remove('hidden');
  document.getElementById('add-task-title').focus();
}

document.getElementById('add-task-cancel').addEventListener('click', () =>
  document.getElementById('add-task-modal').classList.add('hidden'));
document.getElementById('add-task-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('add-task-modal'))
    document.getElementById('add-task-modal').classList.add('hidden');
});

document.getElementById('add-task-submit').addEventListener('click', async () => {
  const title = document.getElementById('add-task-title').value.trim();
  const description = document.getElementById('add-task-desc').value.trim();
  const assigned_to = document.getElementById('add-task-agent').value || undefined;
  const role        = document.getElementById('add-task-role').value || undefined;
  const priority    = Number(document.getElementById('add-task-priority').value) || 0;
  const modal       = document.getElementById('add-task-modal');
  const preId       = modal.dataset.preAssignId;

  if (preId) {
    // Assign-mode: must select an agent
    if (!assigned_to) { alert('Please select an agent to assign this task to.'); return; }
    await fetch(`/queue/tasks/${preId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_to }),
    });
  } else {
    if (!title) return;
    await fetch('/queue/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, assigned_to, role, priority, created_by: 'human' }),
    });
  }
  modal.classList.add('hidden');
  document.getElementById('add-task-title').value = '';
  document.getElementById('add-task-desc').value = '';
  fetchAndRenderQueue(queueFilter);
});

function addOrchBadge(agentName) {
  const nameEl = document.querySelector(`#panel-${escHtml(agentName)} .panel-name`);
  if (!nameEl) return;
  const existing = document.getElementById(`role-badge-${escHtml(agentName)}`);
  if (existing) return;
  const badge = document.createElement('span');
  badge.className = 'badge badge-orch';
  badge.id = `role-badge-${escHtml(agentName)}`;
  badge.textContent = 'orch';
  nameEl.after(badge);
  // Add scratchpad viewer to the task sidebar
  addScratchpadViewer(agentName, orchAgents[agentName]);
}

function addScratchpadViewer(agentName, orchId) {
  const sidebar = document.querySelector(`#panel-${escHtml(agentName)} .task-sidebar`);
  if (!sidebar || document.getElementById(`scratchpad-${escHtml(agentName)}`)) return;
  const section = document.createElement('div');
  section.className = 'scratchpad-section';
  section.innerHTML = `
    <h4 id="scratch-toggle-${escHtml(agentName)}">▶ Scratchpad</h4>
    <pre class="scratchpad-content" id="scratchpad-${escHtml(agentName)}"></pre>
  `;
  sidebar.appendChild(section);

  document.getElementById(`scratch-toggle-${escHtml(agentName)}`).addEventListener('click', () => {
    const content = document.getElementById(`scratchpad-${escHtml(agentName)}`);
    content.classList.toggle('open');
  });

  // Poll scratchpad every 15s while panel exists
  const pollInterval = setInterval(async () => {
    const panel = document.getElementById(`panel-${escHtml(agentName)}`);
    if (!panel) { clearInterval(pollInterval); return; }
    const contentEl = document.getElementById(`scratchpad-${escHtml(agentName)}`);
    if (!contentEl?.classList.contains('open')) return; // only poll when visible
    try {
      const r = await fetch(`/orchestrations/${orchId}/scratchpad`);
      const text = await r.text();
      contentEl.textContent = text;
    } catch {}
  }, 15000);
}

// ============================================================
// Orchestrate modal
// ============================================================

document.getElementById('btn-orchestrate').addEventListener('click', async () => {
  const modal = document.getElementById('orch-modal');
  modal.classList.remove('hidden');
  document.getElementById('orch-goal').focus();

  // Pre-fill workdir
  const wdInput = document.getElementById('orch-workdir');
  if (!wdInput.value) {
    fetch('/config').then(r => r.json()).then(cfg => { wdInput.value = cfg.defaultWorkdir; }).catch(() => {});
  }

  // Populate workspace dropdown
  const wsSel = document.getElementById('orch-workspace');
  fetch('/workspaces').then(r => r.json()).then(list => {
    wsSel.innerHTML = '<option value="">— manual entry —</option>';
    list.forEach(ws => {
      const opt = document.createElement('option');
      opt.value = ws.path; opt.textContent = `${ws.name}  (${ws.path})`;
      wsSel.appendChild(opt);
    });
  }).catch(() => {});

  // Populate project dropdown
  const projSel = document.getElementById('orch-project');
  fetch('/projects').then(r => r.json()).then(projects => {
    projSel.innerHTML = '<option value="">None</option>';
    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      projSel.appendChild(opt);
    });
  }).catch(() => {});

  // Populate model dropdown (reuse router models)
  const modelSel = document.getElementById('orch-model');
  fetch('/router/models').then(r => r.json()).then(models => {
    if (models.error) return;
    while (modelSel.options.length > 1) modelSel.remove(1);
    for (const [provider, list] of Object.entries(models)) {
      const group = document.createElement('optgroup');
      group.label = provider;
      for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        group.appendChild(opt);
      }
      modelSel.appendChild(group);
    }
  }).catch(() => {});
});

document.getElementById('orch-workspace').addEventListener('change', e => {
  if (e.target.value) document.getElementById('orch-workdir').value = e.target.value;
});

document.getElementById('orch-cancel').addEventListener('click', () =>
  document.getElementById('orch-modal').classList.add('hidden'));
document.getElementById('orch-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('orch-modal'))
    document.getElementById('orch-modal').classList.add('hidden');
});

document.getElementById('orch-spawn').addEventListener('click', async () => {
  const goal    = document.getElementById('orch-goal').value.trim();
  const workdir = document.getElementById('orch-workdir').value.trim();
  if (!goal || !workdir) return;
  const model      = document.getElementById('orch-model').value || undefined;
  const project_id = document.getElementById('orch-project').value || undefined;

  const r = await fetch('/orchestrations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, workdir, model, project_id }),
  });
  if (!r.ok) { console.error('Failed to start orchestration'); return; }
  const orch = await r.json();

  // Create the panel immediately (the WS event will also fire, ensurePanel is idempotent)
  ensurePanel({ name: orch.agentName, mode: 'spawn', status: 'running', role: 'orchestrator' });
  orchAgents[orch.agentName] = orch.id;
  addOrchBadge(orch.agentName);

  document.getElementById('orch-modal').classList.add('hidden');
  document.getElementById('orch-goal').value = '';
  document.getElementById('orch-workdir').value = '';
});

// ============================================================
// API Keys modal
// ============================================================

async function renderKeysList() {
  const list = await fetch('/api-keys').then(r => r.json()).catch(() => []);
  const container = document.getElementById('keys-list');
  if (!list.length) {
    container.innerHTML = '<p style="color:#8b949e;font-size:16px;margin:0">No providers configured.</p>';
    return;
  }
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:16px">
      <thead><tr>
        <th style="text-align:left;padding:6px 8px;color:#8b949e;font-weight:normal;border-bottom:1px solid #21262d">Provider</th>
        <th style="text-align:left;padding:6px 8px;color:#8b949e;font-weight:normal;border-bottom:1px solid #21262d">Env Var</th>
        <th style="text-align:left;padding:6px 8px;color:#8b949e;font-weight:normal;border-bottom:1px solid #21262d">Key</th>
        <th style="padding:6px 8px;border-bottom:1px solid #21262d"></th>
      </tr></thead>
      <tbody>
        ${list.map(k => `
          <tr>
            <td style="padding:6px 8px">
              <span style="font-weight:600;color:#e6edf3">${escHtml(k.label)}</span>
              ${!k.seeded ? '<span style="font-size:13px;color:#8b949e;margin-left:6px">(custom)</span>' : ''}
            </td>
            <td style="padding:6px 8px">
              <span style="color:#8b949e;font-size:14px">${escHtml(k.env_var || '—')}</span>
              ${k.env_set
                ? '<span class="badge-env-set">✓ set</span>'
                : '<span class="badge-env-not">not set</span>'}
            </td>
            <td style="padding:6px 8px;font-family:monospace" id="key-cell-${escHtml(k.name)}">
              <span style="color:#8b949e">${escHtml(k.masked)}</span>
            </td>
            <td style="padding:6px 8px;white-space:nowrap;text-align:right">
              <button class="btn-key-edit" data-name="${escHtml(k.name)}"
                style="font-size:13px;padding:2px 8px;border-radius:4px;border:1px solid #30363d;background:none;color:#e6edf3;cursor:pointer;margin-right:4px">Edit</button>
              ${k.has_db_key ? `<button class="btn-key-clear" data-name="${escHtml(k.name)}"
                style="font-size:13px;padding:2px 8px;border-radius:4px;border:1px solid #f8514966;background:none;color:#f85149;cursor:pointer;margin-right:4px">Clear</button>` : ''}
              ${!k.seeded ? `<button class="btn-key-delete" data-name="${escHtml(k.name)}"
                style="font-size:13px;padding:2px 8px;border-radius:4px;border:1px solid #f8514966;background:none;color:#f85149;cursor:pointer">Delete</button>` : ''}
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  container.querySelectorAll('.btn-key-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      const cell = document.getElementById(`key-cell-${name}`);
      cell.innerHTML = `
        <input type="password" id="key-edit-${escHtml(name)}" placeholder="New key value"
          style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:3px 6px;border-radius:4px;font-size:14px;width:180px;font-family:inherit">
        <button class="btn-key-save" data-name="${escHtml(name)}"
          style="font-size:13px;padding:2px 8px;border-radius:4px;border:none;background:#1f6feb;color:#fff;cursor:pointer;margin-left:4px">Save</button>
        <button class="btn-key-cancel"
          style="font-size:13px;padding:2px 8px;border-radius:4px;border:1px solid #30363d;background:none;color:#c9d1d9;cursor:pointer;margin-left:4px">✕</button>
      `;
      cell.querySelector('.btn-key-save').addEventListener('click', async () => {
        const val = document.getElementById(`key-edit-${name}`).value.trim();
        await fetch(`/api-keys/${encodeURIComponent(name)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key_value: val }),
        });
        renderKeysList();
      });
      cell.querySelector('.btn-key-cancel').addEventListener('click', () => renderKeysList());
    });
  });

  container.querySelectorAll('.btn-key-clear').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api-keys/${encodeURIComponent(btn.dataset.name)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key_value: '' }),
      });
      renderKeysList();
    });
  });

  container.querySelectorAll('.btn-key-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete provider "${btn.dataset.name}"?`)) return;
      await fetch(`/api-keys/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
      renderKeysList();
    });
  });
}

document.getElementById('btn-keys').addEventListener('click', () => {
  document.getElementById('keys-modal').classList.remove('hidden');
  renderKeysList();
});
document.getElementById('keys-modal-close').addEventListener('click', () =>
  document.getElementById('keys-modal').classList.add('hidden'));
document.getElementById('keys-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('keys-modal'))
    document.getElementById('keys-modal').classList.add('hidden');
});

document.getElementById('keys-add-btn').addEventListener('click', async () => {
  const name      = document.getElementById('keys-add-name').value.trim();
  const label     = document.getElementById('keys-add-label').value.trim();
  const env_var   = document.getElementById('keys-add-env').value.trim();
  const key_value = document.getElementById('keys-add-value').value.trim();
  if (!name || !label) return;
  const r = await fetch('/api-keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, label, env_var: env_var || null, key_value: key_value || null }),
  });
  if (r.ok) {
    ['keys-add-name','keys-add-label','keys-add-env','keys-add-value']
      .forEach(id => { document.getElementById(id).value = ''; });
    renderKeysList();
  } else {
    const err = await r.json().catch(() => ({}));
    alert(err.error || 'Failed to add provider');
  }
});

async function startup() {
  try {
    const h = await fetch('/health').then(r => r.json());
    if (h.forgejo === 'reachable') {
      document.getElementById('splash').classList.add('hidden');
      connect();
      return;
    }
  } catch {}

  document.getElementById('splash-message').textContent = 'Starting Forgejo…';
  try { await fetch('/api/docker/start', { method: 'POST' }); } catch {}

  let elapsed = 0;
  const poll = setInterval(async () => {
    elapsed += 3;
    try {
      const h = await fetch('/health').then(r => r.json());
      if (h.forgejo === 'reachable') {
        clearInterval(poll);
        document.getElementById('splash').classList.add('hidden');
        connect();
        return;
      }
    } catch {}
    if (elapsed >= 60) {
      clearInterval(poll);
      document.querySelector('.splash-spinner').classList.add('hidden');
      document.getElementById('splash-message').textContent = '';
      const err = document.getElementById('splash-error');
      err.textContent = 'Could not reach Forgejo. Run `docker compose up -d` in a terminal, then refresh.';
      err.classList.remove('hidden');
    }
  }, 3000);
}

startup();

// ============================================================
// Specialists tab
// ============================================================

document.getElementById('btn-specialists').addEventListener('click', () => showView('specialists'));

async function fetchAndRenderSpecialists() {
  const specialists = await fetch('/api/specialists').then(r => r.json()).catch(() => []);
  renderSpecialistsView(specialists);
}

function renderSpecialistsView(specialists) {
  const view = document.getElementById('specialists-view');
  view.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <h2 style="margin:0;flex:1">Specialists</h2>
      <button id="btn-specialist-new" style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:15px">+ New Specialist</button>
      <button id="btn-specialists-back" style="background:none;border:1px solid #30363d;color:#c9d1d9;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:14px">← Dashboard</button>
    </div>
    <div id="specialists-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px"></div>
  `;

  document.getElementById('btn-specialists-back').addEventListener('click', () => showView('agents'));
  document.getElementById('btn-specialist-new').addEventListener('click', openNewSpecialistModal);

  const grid = document.getElementById('specialists-grid');

  if (!specialists.length) {
    grid.innerHTML = '<p style="color:#8b949e;grid-column:1/-1">No specialists yet. Create one to get started.</p>';
    return;
  }

  for (const s of specialists) {
    const card = document.createElement('div');
    card.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:8px';
    const createdByBadge = s.created_by === 'flint'
      ? `<span style="background:#1f3a4f;color:#58a6ff;font-size:11px;padding:1px 6px;border-radius:10px">⚡ Flint</span>`
      : `<span style="background:#1e3a1e;color:#3fb950;font-size:11px;padding:1px 6px;border-radius:10px">Robin</span>`;
    const domainsHtml = (s.domains ?? []).map(d =>
      `<span style="background:#21262d;color:#8b949e;font-size:11px;padding:1px 6px;border-radius:10px">${escHtml(d)}</span>`
    ).join('');
    const lastUsed = s.last_used ? new Date(s.last_used).toLocaleDateString() : 'never';

    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
        <span style="font-weight:600;color:#e6edf3;font-size:15px">${escHtml(s.label)}</span>
        ${createdByBadge}
      </div>
      <div style="color:#8b949e;font-size:13px;line-height:1.4">${escHtml(s.description ?? '')}</div>
      ${domainsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${domainsHtml}</div>` : ''}
      <div style="font-size:12px;color:#6e7681">Used ${s.use_count ?? 0}× · Last: ${lastUsed}</div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button data-spec-edit="${escHtml(s.name)}" style="flex:1;background:none;border:1px solid #30363d;color:#58a6ff;border-radius:4px;padding:4px 0;cursor:pointer;font-size:13px">Edit</button>
        <button data-spec-delete="${escHtml(s.name)}" style="flex:1;background:none;border:1px solid #30363d;color:#f85149;border-radius:4px;padding:4px 0;cursor:pointer;font-size:13px">Delete</button>
      </div>
    `;
    grid.appendChild(card);
  }

  grid.querySelectorAll('[data-spec-edit]').forEach(btn => {
    btn.addEventListener('click', () => openEditSpecialistModal(btn.dataset.specEdit));
  });
  grid.querySelectorAll('[data-spec-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete specialist "${btn.dataset.specDelete}"?`)) return;
      await fetch(`/api/specialists/${encodeURIComponent(btn.dataset.specDelete)}`, { method: 'DELETE' });
      fetchAndRenderSpecialists();
    });
  });
}

// ── Specialist modal ─────────────────────────────────────────────

let _editingSpecialistName = null;

function openNewSpecialistModal() {
  _editingSpecialistName = null;
  showSpecialistModal({ name: '', label: '', description: '', domains: '', preferred_tier: 2, preferred_provider: '', soul: '' });
}

async function openEditSpecialistModal(name) {
  _editingSpecialistName = name;
  const s = await fetch(`/api/specialists/${encodeURIComponent(name)}`).then(r => r.json()).catch(() => null);
  if (!s) return;
  showSpecialistModal({
    name: s.name,
    label: s.label,
    description: s.description ?? '',
    domains: (s.domains ?? []).join(', '),
    preferred_tier: s.preferred_tier ?? 2,
    preferred_provider: s.preferred_provider ?? '',
    soul: s.soul ?? '',
  });
}

function showSpecialistModal({ name, label, description, domains, preferred_tier, preferred_provider, soul }) {
  const existing = document.getElementById('specialist-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'specialist-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:1000';

  overlay.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;width:560px;max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;gap:14px">
      <h3 style="margin:0;color:#e6edf3">${_editingSpecialistName ? 'Edit Specialist' : 'New Specialist'}</h3>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Name (slug)
        <input id="sp-name" type="text" value="${escHtml(name)}" ${_editingSpecialistName ? 'disabled' : ''} placeholder="e.g. research-expert" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Label
        <input id="sp-label" type="text" value="${escHtml(label)}" placeholder="Research Expert" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Description
        <textarea id="sp-description" rows="2" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px;resize:vertical">${escHtml(description)}</textarea>
      </label>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Domains (comma-separated)
        <input id="sp-domains" type="text" value="${escHtml(domains)}" placeholder="research, web, market-analysis" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
      </label>
      <div style="display:flex;gap:12px">
        <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Preferred Tier
          <select id="sp-tier" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
            <option value="1" ${preferred_tier == 1 ? 'selected' : ''}>1 — Fast</option>
            <option value="2" ${preferred_tier == 2 ? 'selected' : ''}>2 — Standard</option>
            <option value="3" ${preferred_tier == 3 ? 'selected' : ''}>3 — Frontier</option>
          </select>
        </label>
        <label style="flex:1;display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Preferred Provider
          <input id="sp-provider" type="text" value="${escHtml(preferred_provider)}" placeholder="anthropic" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:14px">
        </label>
      </div>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:14px;color:#8b949e">Soul (identity — first-person markdown)
        <textarea id="sp-soul" rows="8" style="background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 10px;color:#e6edf3;font-size:13px;font-family:monospace;resize:vertical">${escHtml(soul)}</textarea>
      </label>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="sp-cancel" style="background:none;border:1px solid #30363d;color:#8b949e;border-radius:4px;padding:6px 16px;cursor:pointer">Cancel</button>
        <button id="sp-save" style="background:#1f6feb;color:#fff;border:none;border-radius:4px;padding:6px 16px;cursor:pointer">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('sp-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  document.getElementById('sp-save').addEventListener('click', async () => {
    const nameVal     = document.getElementById('sp-name').value.trim();
    const labelVal    = document.getElementById('sp-label').value.trim();
    const descVal     = document.getElementById('sp-description').value.trim();
    const domainsVal  = document.getElementById('sp-domains').value.split(',').map(d => d.trim()).filter(Boolean);
    const tierVal     = Number(document.getElementById('sp-tier').value);
    const providerVal = document.getElementById('sp-provider').value.trim() || null;
    const soulVal     = document.getElementById('sp-soul').value;

    if (!nameVal || !labelVal) {
      alert('Name and Label are required.');
      return;
    }

    const body = { name: nameVal, label: labelVal, description: descVal, domains: domainsVal, preferred_tier: tierVal, preferred_provider: providerVal, soul: soulVal };

    if (_editingSpecialistName) {
      await fetch(`/api/specialists/${encodeURIComponent(_editingSpecialistName)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: labelVal, description: descVal, domains: domainsVal, preferred_tier: tierVal, preferred_provider: providerVal, soul: soulVal }),
      });
    } else {
      const r = await fetch('/api/specialists', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        alert(err.error ?? 'Failed to create specialist');
        return;
      }
    }

    overlay.remove();
    fetchAndRenderSpecialists();
  });
}
