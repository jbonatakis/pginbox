-include .env
export

DSN := postgresql://pginbox:pginbox@localhost:5499/pginbox?sslmode=disable

PG_LIST_USER ?= $(error set PG_LIST_USER)
PG_LIST_PASS ?= $(error set PG_LIST_PASS)

.PHONY: up down reset psql logs ingest backfill backfill-range charts people seed-people match-people migrate migrate-down migrate-status migrate-new install dev api codegen test install-web dev-web build-api build-frontend prod-up prod-down prod-reload-caddy

up:
	docker compose up -d
	@echo "Waiting for Postgres..."
	@until docker compose exec db pg_isready -U pginbox -d pginbox -q; do sleep 0.5; done
	@echo "Ready: $(DSN)"

down:
	docker compose down

reset:
	docker compose down -v
	docker compose up -d
	@until docker compose exec db pg_isready -U pginbox -d pginbox -q; do sleep 0.5; done
	@echo "Reset complete"

pgcli:
	pgcli $(DSN)

logs:
	docker compose logs -f db

migrate:
	dbmate up

migrate-down:
	dbmate down

migrate-status:
	dbmate status

migrate-new:
	dbmate new $(NAME)

LIST ?= pgsql-hackers

install:
	uv sync

ingest:
	uv run python3 src/ingestion/ingest.py --list $(LIST) --year $(YEAR) --month $(MONTH) $(if $(BACKFILL),--backfill)

backfill:
	uv run python3 src/ingestion/ingest.py --list $(LIST) --year $(YEAR) --month $(MONTH) --backfill

backfill-range:
	uv run python3 src/ingestion/ingest.py --list $(LIST) --from $(FROM) --to $(TO) --backfill $(if $(PARALLEL),--parallel $(PARALLEL))

people: seed-people match-people

seed-people:
	uv run python3 src/ingestion/seed_people.py

match-people:
	uv run python3 src/ingestion/match_people.py $(if $(DRY_RUN),--dry-run)

charts:
	uv run python3 src/ingestion/charts.py

dev:
	bun --watch src/server/index.ts

api:
	bun src/server/index.ts

codegen:
	bun x kysely-codegen --dialect postgres --url $(DATABASE_URL) --out-file src/server/types/db.d.ts

test:
	bun test test

install-web:
	cd src/frontend && npm install

dev-web:
	cd src/frontend && npm run dev

# Production Docker (VPS; DATABASE_URL must be set, e.g. Supabase)
build-api:
	docker build -f Dockerfile.api -t pginbox-api .

build-frontend:
	docker build -f Dockerfile.frontend -t pginbox-frontend .

prod-up:
	docker compose -f docker-compose.prod.yml up -d --build

prod-down:
	docker compose -f docker-compose.prod.yml down

prod-reload-caddy:
	docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
