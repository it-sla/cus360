# Running Customer 360

This project has two main workflows: **Local Docker** (running directly on your PC) and **Remote Development** (the primary workflow). 

---

## 1. Local Docker Workflow (Windows/Mac)

This workflow is best if you want to run everything entirely on your local machine using Docker Desktop.

### Prerequisites
- Ensure **Docker Desktop** is installed and currently running on your PC.

### Initial Setup
If you haven't already, copy the environment variables file:
```bash
cp .env.example .env
```

### Running the App
Start all services (Frontend, Backend, Database, pgAdmin, and CRM Scraper) by running:
```bash
docker compose up --build -d
```
*(The `-d` flag runs it in the background so it doesn't block your terminal).*

### Accessing the Services
Once booted, access the services in your browser:
- **Frontend (Dev)**: http://localhost:5173
- **Backend API**: http://localhost:8360 
- **API Docs (Swagger)**: http://localhost:8360/docs
- **pgAdmin (Database UI)**: http://localhost:5050
- **Frontend (Production Build via Nginx)**: http://localhost:3600

### ⚠️ Troubleshooting Local Dependencies (Blank Screen/Vite Errors)
If you pull new code where `package.json` was updated, your local Docker volume (`frontend_node_modules`) might be caching old dependencies, causing a blank screen or missing dependency errors. 

**Fix it by installing the missing packages directly inside the running container and restarting:**
```bash
docker compose exec frontend npm install
docker compose restart frontend
```

**Check logs if something is failing:**
```bash
docker compose logs -f frontend
docker compose logs -f backend
```

---

## 2. Remote Development Workflow (Primary)

This workflow is used when you are developing on your local laptop but the Docker engine and containers are hosted on the remote server (`shangrila002`).

### Initial Setup (One-time)
```bash
./scripts/remote-compose.sh init
```

### Running the App
This command synchronizes your local files with the remote server and starts Docker Compose on the remote machine:
```bash
./scripts/remote-compose.sh dev
```

### Forwarding Ports to your Laptop
In a separate terminal window, open a tunnel so you can access the remote containers via `localhost` on your laptop:
```bash
./scripts/remote-compose.sh tunnel
```
You can now access `http://localhost:5173` just like you would if it were running locally!

### Useful Remote Commands
```bash
# Run python tests on the remote backend
./scripts/remote-compose.sh exec backend pytest

# Check TypeScript types on the remote frontend
./scripts/remote-compose.sh exec frontend npm run typecheck

# Stop the remote containers
./scripts/remote-compose.sh down
```
