.PHONY: backend frontend test

backend:
	cd backend && python -m uvicorn app.main:app --reload

frontend:
	cd frontend && npm run dev

test:
	cd backend && python -m pytest
	cd frontend && npm run build
