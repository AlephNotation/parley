const read = (name: string) => Bun.file(new URL(`./ui/${name}`, import.meta.url)).text();

export const homePage = await read("home.html");
export const threadPage = await read("thread.html");
export const invitePage = await read("invite.html");
