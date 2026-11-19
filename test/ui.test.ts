import { describe, expect, test } from "bun:test";
import { invitePage, homePage, threadPage } from "../src/ui";

describe("page source", () => {
  test("pages are self-contained: no external scripts, stylesheets or fonts", () => {
    for (const page of [threadPage, homePage, invitePage]) {
      expect(page).not.toMatch(/<script[^>]+src=/i);
      expect(page).not.toMatch(/<link[^>]+rel=["']?stylesheet/i);
      expect(page).not.toMatch(/@import|@font-face|url\(\s*["']?https?:/i);
      expect(page).toContain('<meta name="referrer" content="no-referrer">');
    }
  });

  test("the room page never builds markup from strings", () => {
    // Message text is untrusted: it must only ever reach the page through textContent and DOM nodes.
    expect(threadPage).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/);
  });

  test("every element the room page script looks up exists in its markup", () => {
    const [markup, script] = threadPage.split("<script>") as [string, string];
    const wanted = new Set([...script.matchAll(/\$\("([\w-]+)"\)/g)].map((m) => m[1]!));
    for (const tab of ["online", "setup"]) wanted.add(`tab-${tab}`).add(`panel-${tab}`);
    expect(wanted.size).toBeGreaterThan(20);
    for (const id of wanted) expect(markup).toContain(`id="${id}"`);
  });

  test("the room page writes each message as a messenger line and groups the Buddy List by side", () => {
    expect(threadPage).toContain('head.append(who, " ", time, ...audienceBadges(m, state, toMe), ": ");');
    expect(threadPage).toContain("state.participants.filter((x) => x.side === name)");
  });

  test("the room page flags a room-wide message nobody picked up, from the state's unowned field", () => {
    expect(threadPage).toContain('<div id="unowned" role="status" hidden></div>');
    expect(threadPage).toContain("const u = state.unowned;");
    expect(threadPage).toContain("renderUnowned(state);");
  });

  test("the room page has the audience picker and sends it with a message", () => {
    expect(threadPage).toContain('<select id="to">');
    expect(threadPage).toContain('{ fyi: true }');
    expect(threadPage).toMatch(/api\("\/api\/messages", Object\.assign\(\{ body \}, audienceBody\(\)\)\)/);
  });
});
