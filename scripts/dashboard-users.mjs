import { stdin, stdout } from 'node:process';
import readline from 'node:readline';

import { loadEnv } from './lib/sync-config.mjs';
import { ROLES, ROLE_LABELS, dashboardRoleOf, displayNameOf, isBanned } from './lib/dashboard-auth.mjs';
import { validatePassword } from './lib/dashboard-passwords.mjs';
import { createAdminClient } from './lib/dashboard-user-admin.mjs';

// Who may sign in to the dashboard. Accounts live in Supabase Auth; this is the
// only way to make one — there is no sign-up page.
//
//   npm run users -- list
//   npm run users -- add --email a@qiriness.com --role contact [--name "Ana"]
//   npm run users -- set-password --email a@qiriness.com
//   npm run users -- set-role --email a@qiriness.com --role management
//   npm run users -- disable --email a@qiriness.com      (enable to undo)
//
// PASSWORDS ARE TYPED, NEVER PASSED. `add` and `set-password` prompt with the
// input hidden, so a password never lands in shell history or a process list.
// Without a terminal (a CI job), the password is read from DASHBOARD_PASSWORD.
//
// Roles: developer, management, contact — what each may see is
// scripts/lib/dashboard-auth.mjs.

const [command, ...rest] = process.argv.slice(2);
const args = parseFlags(rest);

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const env = loadEnv();
  const admin = createAdminClient({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY });

  switch (command) {
    case 'list': {
      const users = await admin.listUsers();
      if (users.length === 0) {
        console.log('No accounts yet. Add one with: npm run users -- add --email you@example.com --role developer');
        return;
      }
      for (const user of users) {
        const role = dashboardRoleOf(user);
        // An account without a role cannot open anything; say so rather than
        // leaving a blank column that reads like a display bug.
        const label = role ? ROLE_LABELS[role] : 'NO ROLE (no access)';
        const state = isBanned(user) ? 'DISABLED' : 'active';
        const last = user.last_sign_in_at
          ? `last sign-in ${user.last_sign_in_at.slice(0, 16).replace('T', ' ')}`
          : 'never signed in';
        const name = displayNameOf(user);
        console.log(
          `${String(user.email).padEnd(36)} ${label.padEnd(20)} ${state.padEnd(9)} ${last}${name ? `  (${name})` : ''}`
        );
      }
      return;
    }
    case 'add': {
      const email = requireFlag('email');
      const role = requireRole();
      if (await admin.findByEmail(email)) throw new Error(`${email} already has an account.`);
      const password = await readNewPassword();
      const user = await admin.createUser({ email, password, role, displayName: args.name || null });
      console.log(`Created ${user.email} as ${ROLE_LABELS[role]}.`);
      return;
    }
    case 'set-password': {
      const user = await requireUser();
      const password = await readNewPassword();
      await admin.setPassword(user.id, password);
      console.log(`Password changed for ${user.email}. Their other sessions keep working until they expire.`);
      return;
    }
    case 'set-role': {
      const user = await requireUser();
      const role = requireRole();
      await admin.setRole(user.id, role);
      console.log(`${user.email} is now ${ROLE_LABELS[role]}. Their open session picks this up within a minute.`);
      return;
    }
    case 'disable':
    case 'enable': {
      const user = await requireUser();
      await admin.setDisabled(user.id, command === 'disable');
      console.log(
        command === 'disable'
          ? `${user.email} is disabled. Their open session stops working within a minute.`
          : `${user.email} is enabled again.`
      );
      return;
    }
    default:
      console.log('Usage: npm run users -- <list | add | set-password | set-role | disable | enable> [--email x] [--role r]');
      console.log(`Roles: ${ROLES.join(', ')}`);
      process.exitCode = command ? 1 : 0;
  }

  async function requireUser() {
    const email = requireFlag('email');
    const user = await admin.findByEmail(email);
    if (!user) throw new Error(`No account for ${email}.`);
    return user;
  }
}

function requireFlag(name) {
  const value = args[name];
  if (!value || value === true) throw new Error(`--${name} is required.`);
  return String(value);
}

function requireRole() {
  const role = requireFlag('role').toLowerCase();
  if (!ROLES.includes(role)) throw new Error(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}.`);
  return role;
}

async function readNewPassword() {
  let password;
  if (stdin.isTTY) {
    password = await promptHidden('Password (12+ characters): ');
    const again = await promptHidden('Repeat it: ');
    if (password !== again) throw new Error('The two passwords do not match. Nothing was saved.');
  } else {
    password = process.env.DASHBOARD_PASSWORD;
    if (!password) throw new Error('No terminal to prompt in: set DASHBOARD_PASSWORD for this one command.');
  }
  const check = validatePassword(password);
  if (!check.ok) throw new Error(`${check.error} Nothing was saved.`);
  return password;
}

/** A prompt that echoes nothing while the password is typed. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (text) => {
      if (!muted) stdout.write(text);
    };
    rl.question(question, (answer) => {
      rl.close();
      stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}
