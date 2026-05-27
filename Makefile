# Distributed Mean — Makefile
.PHONY: up down build dev logs ps clean test api-test worker-test

# ─── Docker Compose ──────────────────────────────────────────────────────────

up: ## Start all services
	docker compose up -d

build: ## Build and start all services
	docker compose up --build -d

down: ## Stop all services
	docker compose down

logs: ## Tail all service logs
	docker compose logs -f

ps: ## Show running services
	docker compose ps

clean: ## Stop services and remove volumes
	docker compose down -v

scale-workers: ## Scale workers (usage: make scale-workers N=8)
	docker compose up -d --scale worker=$(N)

# ─── Development ─────────────────────────────────────────────────────────────

dev-api: ## Run API in dev mode
	cd api && npm run dev

dev-install: ## Install all dependencies
	cd api && npm install

# ─── Quality ─────────────────────────────────────────────────────────────────

api-lint: ## Run ESLint on API
	cd api && npm run lint

api-typecheck: ## Run TypeScript type check on API
	cd api && npm run typecheck

api-test: ## Run Jest tests for API
	cd api && npm run test

api-check: ## Run all API quality checks
	cd api && npm run check

worker-lint: ## Run Ruff on workers
	cd workers && ruff check .

worker-format: ## Run Black on workers
	cd workers && black --check .

worker-test: ## Run pytest on workers
	cd workers && pytest -v

worker-check: ## Run all worker quality checks
	cd workers && ruff check . && black --check . && pytest -v

# ─── Utilities ───────────────────────────────────────────────────────────────

submit-job: ## Submit a test job (usage: make submit-job F=20 C=100)
	curl -s -X POST http://localhost:3000/jobs \
		-H "Content-Type: application/json" \
		-d '{"F": $(F), "C": $(C)}' | python3 -m json.tool

system-status: ## Check system status
	curl -s http://localhost:3000/system | python3 -m json.tool

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
