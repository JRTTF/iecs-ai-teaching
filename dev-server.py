#!/usr/bin/env python3
"""靜態檔案開發伺服器，每個回應都加上 no-cache 標頭。

用意：純 http.server 不會送出快取控制標頭，瀏覽器可能會把舊版的
common.js / Style.css 快取住，導致改了程式碼卻在瀏覽器裡看不到效果。
"""
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
    # 用 ThreadingHTTPServer 而非 HTTPServer：後者單執行緒，瀏覽器一條 keep-alive
    # 連線就會把整台伺服器佔住，症狀是埠還在監聽但所有請求都連不進去。
    ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
