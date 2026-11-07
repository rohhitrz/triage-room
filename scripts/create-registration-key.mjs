// Creates a Switch registration key on a local server and saves it to .env.
//
// For Switch Console builds without an API Keys page (0.40.x, native local
// server). It signs in to the gateway with an account you type in, calls
// POST /gateway/api-keys, and writes SWITCH_REGISTRATION_KEY into .env.
// The password is read without echo and never written anywhere. The key is
// written only to .env (gitignored) and never printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const ENV_PATH = ".env";

function readEnvValue(name) {
  if (!existsSync(ENV_PATH)) return "";
  const line = readFileSync(ENV_PATH, "utf8")
    .split("\n")
    .find((l) => l.trim().startsWith(`${name}=`));
  return line ? line.slice(line.indexOf("=") + 1).trim() : "";
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

function saveToEnv(name, value) {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = text.split("\n");
  const index = lines.findIndex((l) => l.trim().startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  writeFileSync(ENV_PATH, lines.join("\n"), { mode: 0o600 });
}

const base = readEnvValue("SWITCH_BASE_URL").replace(/\/$/, "");
if (!base) {
  console.error("Set SWITCH_BASE_URL in .env first.");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("Run this in a terminal so the password can be typed without echo.");
  process.exit(1);
}

console.log(`Switch server: ${base}`);
const email = await ask("Switch account email: ");
const password = await askHidden("Password (hidden): ");

const login = await fetch(`${base}/gateway/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) {
  console.error(`Sign-in failed: ${login.status} ${await login.text()}`);
  process.exit(1);
}
const cookie = login.headers
  .getSetCookie()
  .map((c) => c.split(";")[0])
  .find((c) => c.startsWith("switch_auth="));
if (!cookie) {
  console.error("Signed in, but the server sent no session cookie.");
  process.exit(1);
}

const created = await fetch(`${base}/gateway/api-keys`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ label: "refund-desk" }),
});
if (!created.ok) {
  console.error(`Creating the key failed: ${created.status} ${await created.text()}`);
  process.exit(1);
}
const { key, label } = await created.json();
if (!key) {
  console.error("The server answered without a key.");
  process.exit(1);
}
saveToEnv("SWITCH_REGISTRATION_KEY", key);
console.log(`Created registration key "${label}" and saved it to .env (${key.length} characters, not shown).`);
console.log("Next: npm run register");
