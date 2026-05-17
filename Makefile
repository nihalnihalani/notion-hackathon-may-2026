.PHONY: install test run demo

VENV = venv
PYTHON = $(VENV)/bin/python
PIP = $(VENV)/bin/pip

install:
	@if [ ! -x "$(PIP)" ]; then python3 -m venv $(VENV); fi
	$(PIP) install -r requirements.txt

test:
	PYTHONPATH=. $(PYTHON) -m pytest tests/

run:
	$(PYTHON) notion_warroom_bridge.py

demo:
	PATH="$(shell pwd)/$(VENV)/bin:$$PATH" PYTHONPATH=. $(PYTHON) scripts/demo_check.py
