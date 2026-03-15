-include .env
export

DSN := postgresql://pginbox:pginbox@localhost:5499/pginbox?sslmode=disable

PG_LIST_USER ?= $(error set PG_LIST_USER)
PG_LIST_PASS ?= $(error set PG_LIST_PASS)

.PHONY: up down reset psql logs ingest backfill backfill-range derive-threads decode-subjects refresh-analytics charts people seed-people match-people migrate migrate-down migrate-status migrate-new install dev api codegen test install-web dev-web build-api build-frontend build-all deploy prod-up prod-up-no-build prod-down restart prod-reload-caddy

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
	env -u DSN pgcli "$(DSN)"

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

force-backfill:
	uv run python3 src/ingestion/ingest.py --list $(LIST) --year $(YEAR) --month $(MONTH) --backfill --force-download

backfill-range:
	uv run python3 src/ingestion/ingest.py --list $(LIST) --from $(FROM) --to $(TO) --backfill $(if $(PARALLEL),--parallel $(PARALLEL))

derive-threads:
	uv run python3 src/ingestion/ingest.py --dsn $(DSN) --derive-only

decode-subjects:
	uv run python3 src/ingestion/ingest.py --dsn $(DSN) --decode-subjects

refresh-analytics:
	psql $(DSN) -c "SELECT refresh_analytics_views();"

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

build-all: build-api build-frontend

prod-up:
	docker compose -f docker-compose.prod.yml up -d --build

prod-up-no-build:
	docker compose -f docker-compose.prod.yml up -d

prod-down:
	docker compose -f docker-compose.prod.yml down

restart: prod-down prod-up

prod-reload-caddy:
	docker compose -f docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile

deploy: build-all prod-up-no-build
