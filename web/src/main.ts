import { createEditor, newBlock } from "./editor.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;

type User = {
  id: number;
  email: string;
};

type Page = {
  id: number;
  title: string;
  updated_at: number;
};

function makeLink(text: string, path: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = path;
  link.textContent = text;
  link.addEventListener("click", (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(path);
  });
  return link;
}

async function postJson(url: string, body: object): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function renderHome() {
  const title = document.createElement("h1");
  title.textContent = "notion-clone";
  app.replaceChildren(title, makeLink("Log in", "/login"));
}

function renderLogin() {
  const title = document.createElement("h1");
  title.textContent = "Log in";
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.type = "email";
  input.name = "email";
  input.placeholder = "you@example.com";
  input.required = true;
  const button = document.createElement("button");
  button.textContent = "Send code";
  form.append(input, button);
  const message = document.createElement("p");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = input.value;
    const response = await postJson("/api/auth/request-code", { email });
    if (!response.ok) {
      message.textContent = "Could not send a code to that address";
      return;
    }
    renderCodeForm(email);
  })
  app.replaceChildren(title, form, message, makeLink("Home", "/"));
}

function renderCodeForm(email: string) {
  const title = document.createElement("h1");
  title.textContent = "Check your email";
  const hint = document.createElement("p");
  hint.textContent = "Code sent to " + email;
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.name = "code";
  input.inputMode = "numeric";
  input.autocomplete = "one-time-code";
  input.maxLength = 6;
  input.required = true;
  const button = document.createElement("button");
  button.textContent = "Log in";
  form.append(input, button);
  const message = document.createElement("p");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const response = await postJson("/api/auth/verify", { email, code: input.value });
    if (!response.ok) {
      message.textContent = "Wrong or expired code";
      return;
    }
    navigate("/workspace");
  });
  app.replaceChildren(title, hint, form, message, makeLink("Start again", "/login"));
}

async function renderWorkspace() {
  app.replaceChildren("Loading...");
  // Check cookie
  const response = await fetch("/api/me");
  if (response.status === 401) {
    redirect("/login");
    return;
  }
  // Log in, user info
  const user: User = await response.json();
  const title = document.createElement("h1");
  title.textContent = "Workspace";
  const who = document.createElement("p");
  who.textContent = "Logged in as " + user.email;
  const logout = document.createElement("button");
  logout.textContent = "Log out";
  logout.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    navigate("/");
  });
  // Pages
  const pagesResponse = await fetch("/api/pages");
  const pages: Page[] = await pagesResponse.json();
  const list = document.createElement("ul");
  for (const page of pages) {
    const item = document.createElement("li");
    item.append(makeLink(page.title, "/page/" + page.id));
    list.append(item);
  }
  const empty = document.createElement("p");
  empty.textContent = "No pages yet";
  const create = document.createElement("button");
  create.textContent = "Create page";
  create.addEventListener("click", async () => {
    const response = await fetch("/api/pages", { method: "POST" });
    const page: Page = await response.json();
    navigate("/page/" + page.id);
  })
  app.replaceChildren(title, who, logout, pages.length > 0 ? list : empty, create);
}

async function renderPage(pageId: number) {
  app.replaceChildren("Loading...");
  const response = await fetch("/api/pages/" + pageId);
  if (response.status === 401) {
    redirect("/login");
    return;
  }
  if (response.status === 404) {
    renderNotFound();
    return;
  }
  const page: Page = await response.json();
  const title = document.createElement("h1");
  title.textContent = page.title;
  title.contentEditable = "true";
  const blocks = [newBlock("")];
  const editor = createEditor(blocks);
  app.replaceChildren(makeLink("Back to workspace", "/workspace"), title, editor);
}

function renderNotFound() {
  const title = document.createElement("h1");
  title.textContent = "Page not found";
  app.replaceChildren(title, makeLink("Home", "/"));
}

const routes: Record<string, () => void> = {
  "/": renderHome,
  "/login": renderLogin,
  "/workspace": renderWorkspace,
};

function render() {
  const path = location.pathname;
  if (path.startsWith("/page/")) {
    const pageId = Number(path.slice("/page/".length));
    if (Number.isInteger(pageId)) {
      renderPage(pageId);
    } else {
      renderNotFound();
    }
    return;
  }
  const view = routes[path] ?? renderNotFound;
  view();
}

function navigate(path: string) {
  history.pushState(null, "", path);
  render();
}

// Like navigate, but replaces the current history instead of adding one
function redirect(path: string) {
  history.replaceState(null, "", path);
  render();
}

window.addEventListener("popstate", render);
render();