const app = document.querySelector<HTMLDivElement>("#app")!;

function makeLink(text: string, path: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = path;
  link.textContent = text;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    navigate(path);
  });
  return link;
}

function renderHome() {
  const title = document.createElement("h1");
  title.textContent = "notion-clone";
  app.replaceChildren(title, makeLink("Log in", "/login"));
}

function renderLogin() {
  const title = document.createElement("h1");
  title.textContent = "Log in";
  app.replaceChildren(title, makeLink("Home", "/"));
}

function renderWorkspace() {
  const title = document.createElement("h1");
  title.textContent = "Workspace";
  app.replaceChildren(title);
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
  const view = routes[location.pathname] ?? renderNotFound;
  view();
}

function navigate(path: string) {
  history.pushState(null, "", path);
  render();
}

window.addEventListener("popstate", render);
render();