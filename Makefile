-include .env
export

DSN := postgresql://pginbox:pginbox@localhost:5499/pginbox?sslmode=disable
TEXTSEARCH_COMPOSE := COMPOSE_PROJECT_NAME=pginbox_textsearch docker compose -f docker-compose.yml -f docker-compose.pg_textsearch.yml

PG_LIST_USER ?= $(error set PG_LIST_USER)
PG_LIST_PASS ?= $(error set PG_LIST_PASS)

.PHONY: up down reset up-textsearch down-textsearch reset-textsearch smoke-textsearch pgcli logs ingest backfill backfill-range reconcile reconcile-range derive-threads decode-subjects refresh-analytics charts people seed-people match-people migrate migrate-down migrate-status migrate-new migrate-test install dev api auth-cleanup my-threads-backfill codegen test test-server test-frontend test-ingestion test-db install-web dev-web build-api build-frontend build-all deploy prod-up prod-up-no-build prod-down restart prod-reload-caddy

up:
	docker compose up -d
	@echo "Waiting for Postgres..."
	@until docker compose exec db pg_isready -U pginbox -d pginbox -q; do sleep 0.5; done
	@echo "Ready: $(DSN)"

up-textsearch:
	docker compose down
	$(TEXTSEARCH_COMPOSE) up -d --build
	@echo "Waiting for Postgres with pg_textsearch..."
	@until $(TEXTSEARCH_COMPOSE) exec db pg_isready -U pginbox -d pginbox -q; do sleep 0.5; done
	@echo "Ready with pg_textsearch: $(DSN)"

down:
	docker compose down

down-textsearch:
	$(TEXTSEARCH_COMPOSE) down

reset:
	docker compose down -v
	docker compose up -d
	@until docker compose exec db pg_isready -U pginbox -d pginbox -q; do sleep 0.5; done
	@echo "Reset complete"

reset-textsearch:
	docker compose down
	$(TEXTSEARCH_COMPOSE) down -v
	$(TEXTSEARCH_COMPOSE) up -d --build
	@until $(TEXTSEARCH_COMPOSE) exec db pg_isready -U pginbox -d pginbox -q; do sleep 0.5; done
	@echo "Reset complete with pg_textsearch"

pgcli:
	env -u DSN pgcli "$(DSN)"

smoke-textsearch:
	psql $(DSN) -f db/pg_textsearch_smoke.sql

logs:
	docker compose logs -f db

migrate:
	dbmate up

migrate-test:
	@test -n "$(TEST_DATABASE_URL)" || (echo "set TEST_DATABASE_URL" && exit 1)
	DATABASE_URL="$(TEST_DATABASE_URL)" dbmate up

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

reconcile:
	uv run python3 src/ingestion/ingest.py --list $(LIST) --year $(YEAR) --month $(MONTH) --reconcile-existing

reconcile-range:
	uv run python3 src/ingestion/ingest.py --list $(LIST) --from $(FROM) --to $(TO) --reconcile-existing

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

auth-cleanup:
	bun src/server/jobs/auth-cleanup.ts

my-threads-backfill:
	bun src/server/jobs/my-threads-historical-backfill.ts $(if $(BATCH_SIZE),--batch-size $(BATCH_SIZE)) $(if $(MAX_USERS),--max-users $(MAX_USERS)) $(if $(START_AFTER_USER_ID),--start-after-user-id $(START_AFTER_USER_ID))

codegen:
	bun x kysely-codegen --dialect postgres --url $(DATABASE_URL) --out-file src/server/types/db.d.ts

test:
	$(MAKE) test-server
	$(MAKE) test-frontend
	$(MAKE) test-ingestion

test-server:
	bun test test/server

test-frontend:
	bun test test/frontend

test-ingestion:
	uv run pytest -q test/ingestion

test-db:
	@test -n "$(TEST_DATABASE_URL)" || (echo "set TEST_DATABASE_URL" && exit 1)
	bun test test/server/auth.test.ts test/server/auth-routes.test.ts test/server/auth-maintenance.test.ts

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

deploy: build-all prod-up-no-build prod-reload-caddy

watch-logs:
	docker compose -f docker-compose.prod.yml logs -f api frontend
