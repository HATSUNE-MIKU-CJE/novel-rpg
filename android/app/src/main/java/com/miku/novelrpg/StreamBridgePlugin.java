package com.miku.novelrpg;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * v2.2.1 原生 SSE 流式桥。
 *
 * 背景：真机上 WebView fetch 受 CORS 限制——opencode-go 等网关无 CORS 头时，
 * 请求直接失败并回退 CapacitorHttp 全量，表现为「没有流式输出」。
 * 本插件走原生 HttpURLConnection（无 CORS 概念），逐行把 SSE data 原样推回 JS，
 * JS 侧自行解析 delta（与 Web 路径共用同一套解析）。
 *
 * 事件通道：chunk(data 行) / done / error(message)；每次调用带 id，JS 端按 id 过滤，
 * 防止旧流（被新流顶替）的事件串台。
 */
@CapacitorPlugin(name = "StreamBridge")
public class StreamBridgePlugin extends Plugin {

    private volatile HttpURLConnection active;

    @PluginMethod
    public void chatStream(PluginCall call) {
        String url = call.getString("url");
        String headersJson = call.getString("headersJson");
        String body = call.getString("body");
        String idRaw = call.getString("id");
        final String id = idRaw == null ? "" : idRaw;
        if (url == null || body == null) {
            call.reject("url/body 必填");
            return;
        }

        // 顶替上一个仍在跑的流（JS 端按 id 过滤旧流事件）
        HttpURLConnection old = active;
        active = null;
        if (old != null) old.disconnect();

        Thread worker = new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(30000);
                conn.setReadTimeout(300000);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("Accept", "text/event-stream");
                try {
                    JSONObject h = new JSONObject(headersJson == null ? "{}" : headersJson);
                    for (java.util.Iterator<String> it = h.keys(); it.hasNext(); ) {
                        String k = it.next();
                        conn.setRequestProperty(k, h.optString(k));
                    }
                } catch (Exception ignore) { /* 坏头忽略 */ }
                conn.setDoOutput(true);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }

                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) {
                    String err = readAll(conn.getErrorStream());
                    notifyListeners("error", new JSObject().put("id", id).put("message", "HTTP " + code + ": " + (err.isEmpty() ? "请求失败" : err)));
                    return;
                }

                active = conn;
                try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        String t = line.trim();
                        if (t.startsWith("data:")) {
                            notifyListeners("chunk", new JSObject().put("id", id).put("data", t));
                        }
                    }
                }
                notifyListeners("done", new JSObject().put("id", id));
            } catch (Exception e) {
                // 被顶替（disconnect）时无需上报；连接失败/中断才上报
                if (conn != null && conn == active) {
                    notifyListeners("error", new JSObject().put("id", id)
                        .put("message", e.getMessage() == null || e.getMessage().isEmpty() ? "网络异常" : e.getMessage()));
                }
            } finally {
                if (conn == active) active = null;
            }
        });
        worker.setDaemon(true);
        worker.start();
        call.resolve(); // 立即返回；流事件经 notifyListeners 通道
    }

    @PluginMethod
    public void cancelStream(PluginCall call) {
        HttpURLConnection c = active;
        active = null;
        if (c != null) c.disconnect();
        call.resolve();
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) sb.append(line).append('\n');
            return sb.toString().length() > 300 ? sb.substring(0, 300) : sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
