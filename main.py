#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Entry point cho môi trường Hosting (Botkeep, Render, Railway, v.v.) và Local.
Tự động nhận diện host và port từ biến môi trường (SERVER_PORT / PORT).
"""
import os
import uvicorn

if __name__ == "__main__":
    # Botkeep cung cấp SERVER_PORT, các nền tảng khác thường là PORT
    port_env = os.environ.get("SERVER_PORT") or os.environ.get("PORT") or "8899"
    port = int(port_env)
    
    # Trên server cloud cần bind vào 0.0.0.0 để nhận kết nối từ bên ngoài
    host = os.environ.get("HOST", "0.0.0.0")
    
    print(f"[*] Starting Novel App on {host}:{port}...")
    uvicorn.run("server.app:app", host=host, port=port)
