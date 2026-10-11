@echo off
title Novel App Server
echo Dang khoi dong Novel App Server...
start http://127.0.0.1:8899/
.\server\venv\Scripts\python -m uvicorn server.app:app --host 127.0.0.1 --port 8899
pause