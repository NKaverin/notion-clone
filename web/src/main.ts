const app = document.querySelector<HTMLDivElement>("#app")!;

app.textContent = "notion-clone"

type Health = {
  status: string;
};

async function loadHealth() {
  const response = await fetch("/api/health");
  if (!response.ok) {
    app.textContent = "server error: " + response.status;
    return;
  }
  const data: Health = await response.json();

  app.textContent = "sever says " + data.status; 
}

loadHealth()