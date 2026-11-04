import { createEditor, newBlock, type Block } from "./editor.ts";
import "./style.css"

const app = document.querySelector<HTMLDivElement>("#app")!;

type User = {
  id: number;
  email: string;
};

type Page = {
  id: number;
  title: string;
  parent_id: number | null;
  position: number;
  updated_at: number;
};

type PageWithBlocks = Page & {
  blocks: Block[];
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

// For the responce that is not 2xx
class HttpError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super("HTTP " + status + " from " + url);
    this.status = status;
  }
}

async function getJson<T>(url:string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new HttpError(response.status, url);
  }
  return response.json();
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

const expanded = new Set<number>();

let draggingId: number | null = null;

async function refreshSidebar() {
  const [user, pages] = await Promise.all([
    getJson<User>("/api/me"), 
    getJson<Page[]>("/api/pages")
  ]);
  const match = location.pathname.match(/^\/page\/(\d+)$/);
  const currentId = match === null ? null : Number(match[1]);
  document.querySelector(".sidebar")!.replaceWith(buildSidebar(user, pages, currentId));
}

async function movePage(pageId: number, parentId: number | null, index: number) {
  const responce = await fetch("/api/pages/" + pageId + "/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify( { parentId: parentId, index })
  });
  if (!responce.ok) {
    console.error(responce.status);
  }
  await refreshSidebar();
}

function dropZone(row: HTMLElement, event: DragEvent): "before" | "after" | "inside" {
  const box = row.getBoundingClientRect();
  const y = event.clientY - box.top;
  if (y < box.height / 4) {
    return "before";
  }
  if (y > (box.height * 3) / 4) {
    return "after";
  }
  return "inside";
}

function buildTree(parentId: number | null, byParent: Map<number | null, Page[]>, currentId: number | null): HTMLUListElement {
  const list = document.createElement("ul");
  for (const page of byParent.get(parentId) ?? []) {
    const item = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row";
    const toggle = document.createElement("button");
    toggle.className = "toggle";
    const link = makeLink(page.title || "Untitled", "/page/" + page.id);
    link.dataset.pageId = String(page.id);
    if (page.id === currentId) {
      link.setAttribute("aria-current", "page");
    }
    const add = document.createElement("button");
    add.className = "add";
    add.textContent = "+";
    add.title = "Add a page inside";
    add.addEventListener("click", async () => {
      const responce = await fetch("/api/pages/" + page.id + "/children", { method: "POST" });
      const child: Page = await responce.json();
      expanded.add(page.id);
      navigate("/page/" + child.id);
    });
    // Drag'n'drop
    row.draggable = true;
    row.addEventListener("dragstart", (event) => {
      draggingId = page.id;
      event.dataTransfer!.effectAllowed = "move";
      event.dataTransfer!.setData("text/plain", String(page.id));
    });
    row.addEventListener("dragend", () => {
      draggingId = null;
    });
    row.addEventListener("dragover", (event) => {
      if (draggingId === null) {
        return;
      }
      const draggedItem = document.querySelector('.sidebar [data-page-id="' + draggingId + '"]')!.closest("li")!;
      if (draggedItem.contains(row)) {
        return;
      }
      event.preventDefault();
      row.dataset.drop = dropZone(row, event);
    });
    row.addEventListener("dragleave", () => {
      delete row.dataset.drop;
    });
    row.addEventListener("drop", async (event) => {
      event.preventDefault();
      delete row.dataset.drop;
      if (draggingId === null) {
        return;
      }
      const moving = draggingId;
      const zone = dropZone(row, event);
      const parentId = zone === "inside" ? page.id : page.parent_id;
      const siblings = (byParent.get(parentId) ?? []).filter((p) => p.id !== moving);
      let index = siblings.length;
      if (zone === "before") {
        index = siblings.findIndex((p) => p.id === page.id);
      }
      if (zone === "after") {
        index = siblings.findIndex((p) => p.id === page.id) + 1;
      }
      if (zone === "inside") {
        expanded.add(page.id);
      }
      await movePage(moving, parentId, index);
    });

    row.append(toggle, link, add);
    item.append(row);
    const children = byParent.get(page.id) ?? [];
    if (children.length > 0) {
      const childList = buildTree(page.id, byParent, currentId);
      childList.hidden = !expanded.has(page.id);
      toggle.textContent = childList.hidden ? "▸" : "▾";
      toggle.addEventListener("click", ()=> {
        childList.hidden = !childList.hidden;
        if (childList.hidden) {
          expanded.delete(page.id);
        } else {
          expanded.add(page.id);
        }
        toggle.textContent = childList.hidden ? "▸" : "▾";
      });
      item.append(childList);
    } else {
      toggle.style.visibility = "hidden";
    }
    list.append(item);
  }
  return list;
}

function buildSidebar(user: User, pages: Page[], currentId: number | null) : HTMLElement {
  const sidebar = document.createElement("nav");
  sidebar.className = "sidebar";
  const who = document.createElement("p");
  who.textContent = user.email;
  // Group by parent
  const byParent = new Map<number | null, Page[]>();
  const byId = new Map<number, Page>();
  for (const page of pages) {
    byId.set(page.id, page);
    const siblings = byParent.get(page.parent_id) ?? [];
    siblings.push(page);
    byParent.set(page.parent_id, siblings);
  }
  // Open every ancestor of the current page
  let ancestor = currentId === null ? null : byId.get(currentId)?.parent_id ?? null;
  while (ancestor !== null) {
    expanded.add(ancestor);
    ancestor = byId.get(ancestor)?.parent_id ?? null;
  }
  const list = buildTree(null, byParent, currentId);
  const create = document.createElement("button");
  create.textContent = "New page";
  create.addEventListener("click", async () => {
    const response = await fetch("/api/pages", { method: "POST" });
    const page: Page = await response.json();
    navigate("/page/" + page.id);
  });
  const logout = document.createElement("button");
  logout.textContent = "Log out";
  logout.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    navigate("/");
  })
  sidebar.append(who, list, create, logout);
  return sidebar;
}

function showLayout(sidebar: HTMLElement, ...content: (Node | string)[]) {
  const main = document.createElement("main");
  main.className = "content";
  main.append(...content);
  const layout = document.createElement("div");
  layout.className = "layout";
  layout.append(sidebar, main);
  app.replaceChildren(layout);
}

async function renderWorkspace() {
  app.replaceChildren("Loading...");
  // Check cookie
  const [user, pages] = await Promise.all([
    getJson<User>("/api/me"),
    getJson<Page[]>("/api/pages"),
  ]);
  const hint = document.createElement("p");
  hint.textContent = pages.length > 0 ? "Pick a page on the left." : "No pages yet. Click New page.";
  showLayout(buildSidebar(user, pages, null), hint);  
}

async function renderPage(pageId: number) {
  app.replaceChildren("Loading...");
  const [page, user, pages] = await Promise.all([
    getJson<PageWithBlocks>("/api/pages/" + pageId),
    getJson<User>("/api/me"),
    getJson<Page[]>("/api/pages"),
  ]);
  // A user may have move on
  if (location.pathname !== "/page/" + pageId) {
    return;
  }
  const sidebar = buildSidebar(user, pages, pageId);
  const title = document.createElement("h1");
  title.textContent = page.title;
  title.contentEditable = "true";
  // New page has no blocks, one empty paragraph
  const blocks = page.blocks.length > 0 ? page.blocks : [newBlock("")];
  const editor = createEditor(blocks);
  const status = document.createElement("p");
  status.textContent = "Saved";

  async function save() {
    status.textContent = "Saving...";
    const response = await fetch("/api/pages/" + pageId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.textContent, blocks}),
    });
    status.textContent = response.ok ? "Saved" : "Save failed: " + response.status;
  }

  // Every edit change restarts a 500 ms timer
  let timer: number | undefined;
  function scheduleSave() {
    status.textContent = "Unsaved changes";
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  } 
  // Every edit = DOM changing (except inside an equation, save happens on blur)
  const observer = new MutationObserver(scheduleSave);
  const watch = { childList: true, characterData: true, subtree: true};
  observer.observe(editor, watch);
  observer.observe(title, watch);

  // A title is one line, enter moves into the content instead of adding a line
  title.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      const first = editor.firstElementChild as HTMLElement;
      first.focus();
    }
  });
  title.addEventListener("input", () => {
    const link = document.querySelector('.sidebar [data-page-id="' + pageId + '"]');
    if (link !== null) {
      link.textContent = title.textContent || "Untitled";
    }
  });
  const duplicate = document.createElement("button");
  duplicate.textContent = "Duplicate";
  duplicate.addEventListener("click", async () => {
    // Save first
    clearTimeout(timer);
    await save();
    const response = await fetch("/api/pages/" + pageId + "/duplicate", { method: "POST" });
    const copy: Page = await response.json();
    navigate("/page/" + copy.id)
  })
  showLayout(sidebar, status, duplicate, title, editor);
}

function renderNotFound() {
  const title = document.createElement("h1");
  title.textContent = "Page not found";
  app.replaceChildren(title, makeLink("Home", "/"));
}

function renderError(error: unknown) {
  const title = document.createElement("h1");
  title.textContent = "Something went wrong";
  const detail = document.createElement("p");
  detail.textContent = String(error);
  app.replaceChildren(title, detail, makeLink("Home", "/"));
}

const routes: Record<string, () => Promise<void> | void> = {
  "/": renderHome,
  "/login": renderLogin,
  "/workspace": renderWorkspace,
};

async function render() {
  const path = location.pathname;
  try {
    if (path.startsWith("/page/")) {
      const pageId = Number(path.slice("/page/".length));
      if (Number.isInteger(pageId)) {
        await renderPage(pageId);
      } else {
        renderNotFound();
      }
      return;
    }
    const view = routes[path] ?? renderNotFound;
    await view();
  } catch (error) {
    console.error("render failed", error);
    if (location.pathname !== path) {
      return;
    }
    if (error instanceof HttpError && error.status === 401) {
      redirect("/login")
    } else if (error instanceof HttpError && error.status === 404) {
      renderNotFound();
    } else {
      renderError(error);
    }
  }
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