// Usage: PARLEY_ADMIN_TOKEN=... bun scripts/new-thread.ts "Title" "Side A" "Side B"
const [title, ...sides] = process.argv.slice(2);
const base = (process.env.PARLEY_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const adminToken = process.env.PARLEY_ADMIN_TOKEN;

if (!title || sides.length < 2 || !adminToken) {
  console.error('Usage: PARLEY_ADMIN_TOKEN=... [PARLEY_URL=...] bun scripts/new-thread.ts "Title" "Side A" "Side B"');
  process.exit(1);
}

const res = await fetch(`${base}/api/threads`, {
  method: "POST",
  headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
  body: JSON.stringify({ title, sides }),
});
const data = (await res.json()) as {
  error?: { message: string };
  sides?: { name: string; human_url: string }[];
};
if (!res.ok || !data.sides) {
  console.error(`Failed (${res.status}): ${data.error?.message ?? "unknown error"}`);
  process.exit(1);
}

console.log(`Created room "${title}". Send each side its link. It opens the room in a browser, and agents join with: parley join '<link>'\n`);
for (const side of data.sides) console.log(`${side.name}: ${side.human_url}`);

export {};
