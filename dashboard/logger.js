export function log(level, msg, data = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }) + '\n'
  );
}

export const info  = (msg, data) => log('info',  msg, data ?? {});
export const warn  = (msg, data) => log('warn',  msg, data ?? {});
export const error = (msg, data) => log('error', msg, data ?? {});
