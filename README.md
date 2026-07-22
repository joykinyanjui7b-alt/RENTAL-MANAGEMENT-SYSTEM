# System Documentation Tracker

This repository is split into two independent apps:

- `backend/` — Node.js API server and PostgreSQL database setup
- `frontend/` — static frontend assets and runtime config generation

## Backend

1. Change into the backend folder:

```bash
cd backend
```

2. Install dependencies:

```bash
npm install
```

3. Copy environment variables:

```bash
cp .env.example .env
```

4. For local development, leave `DATABASE_URL` blank. The backend will use a local file database at `backend/dev-db.json`.

5. For deployment or PostgreSQL testing, set `DATABASE_URL` to your Postgres connection string.

6. Start the backend server:

```bash
npm run dev
```

By default the backend listens on `http://localhost:3000`.

> If you use Postgres, run `npm run db:init` first to create the schema.

## Frontend

1. Change into the frontend folder:

```bash
cd frontend
```

2. Install dependencies:

```bash
npm install
```

3. Copy environment variables:

```bash
cp .env.example .env
```

4. Open `frontend/.env` and update `API_BASE_URL` if needed.

5. Generate runtime config for the API base URL:

```bash
npm run build
```

6. Start the frontend locally:

```bash
npm run dev
```

If you prefer a preview command, you can also use:

```bash
npm run preview
```

The frontend will load API requests from the configured `API_BASE_URL`.

## Local development

- Set `DATABASE_URL` in `backend/.env` for your local Postgres instance.
- Set `API_BASE_URL` when building the frontend if frontend and backend are separate.

## Vercel frontend deployment

1. Create a new Vercel project from this repository.
2. Set the root directory to `frontend/`.
3. Set Build Command to:

```bash
npm run build
```

4. Set Output Directory to:

```text
public
```

5. Add Environment Variable:

- `API_BASE_URL` → `https://<your-backend>.onrender.com`

## Render backend deployment

1. Create a new Web Service on Render.
2. Connect the repository or use the existing `backend/` folder.
3. Set the Environment Variable:

- `DATABASE_URL` → your Postgres connection string

4. Use the start command:

```bash
npm run start
```

## API

- `GET /api/health`
- `GET /api/me`
- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/dashboard`
- `GET /api/documents`
- `POST /api/documents`
- `PUT /api/documents/:id`
- `DELETE /api/documents/:id`
- `POST /api/notes`
- `DELETE /api/notes/:id`

## Role workflows

The application uses three roles:

- **Tenant** — signs in, views vacant houses, submits a house application, and tracks their own application summary. Tenant requests cannot read or change landlord records, payments, applications, or reports.
- **Landlord** — manages tenant records, reviews and approves or rejects applications, records rent payments, and generates reports.
- **Admin** — has the landlord management capabilities for oversight and operational support. Admin accounts are controlled by the system and cannot be created through the public registration form.

The normal rental workflow is:

1. A tenant signs in and selects a vacant house.
2. The tenant submits an application with a viewing message.
3. A landlord or admin reviews the application.
4. Approval creates an active tenant record and marks the house occupied; rejection leaves the house available.
5. Landlords record payments and can archive a tenant when they move out, which preserves the history and makes the house vacant.

Management endpoints return `403` for roles that are not allowed to use them. This authorization is enforced by the backend, not only by hiding frontend navigation.
