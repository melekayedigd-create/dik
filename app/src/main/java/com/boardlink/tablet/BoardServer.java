package com.boardlink.tablet;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.Charset;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * BoardLink server that runs INSIDE the tablet app.
 *  - serves the tablet UI (to the app's own WebView) and the PC UI (to Chrome on the PC)
 *  - keeps the board state and relays drawing events in real time (Server-Sent Events + POST)
 *  - calls the Claude API for the AI window
 * Pure Java (no Android classes) so it can also be tested on a computer.
 */
public final class BoardServer {

    public interface Assets { byte[] read(String path) throws IOException; }

    public interface Store { String get(String key, String def); void put(String key, String value); }

    public static final int DEFAULT_PORT = 8765;
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final Charset LATIN1 = Charset.forName("ISO-8859-1");
    private static final byte[] PING = ": ping\n\n".getBytes(UTF8);
    private static final Set<String> LAYER_EVENTS = new HashSet<>(Arrays.asList("begin", "add", "pts", "end", "update", "remove", "clear", "restore"));
    private static final String DEFAULT_MODEL = "claude-haiku-5-5";
    private static final String SYSTEM_PROMPT =
        "You are the AI helper inside BoardLink, a drawing board used on a tablet connected to a PC "
        + "(often while teaching, presenting or in a meeting). Answers appear in a small window and may be read aloud, "
        + "so be clear and brief: a few short paragraphs at most. Reply in the language the user writes in "
        + "(French, English, Arabic or Tunisian Derja). If a picture of the board is attached, it shows what the user "
        + "drew or wrote; use it when it is relevant. Use plain text; simple \"- \" lists are fine, no tables or headings.";

    private final int port;
    private final Assets assets;
    private final Store store;
    private final Object lock = new Object();
    private final Map<String, Object> state = new LinkedHashMap<>();
    private final Map<String, Client> clients = new LinkedHashMap<>();
    private final Map<String, Image> images = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private ServerSocket serverSocket;
    private volatile boolean running;

    private static final class Image { final byte[] data; final String type; Image(byte[] d, String t) { data = d; type = t; } }

    private static final class HttpError extends Exception {
        final int status;
        HttpError(int status, String msg) { super(msg); this.status = status; }
    }

    public BoardServer(int port, Assets assets, Store store) {
        this.port = port;
        this.assets = assets;
        this.store = store;
        state.put("mode", "menu");
        state.put("bg", "white");
        state.put("videoAspect", 16.0 / 9.0);
        Map<String, Object> layers = new LinkedHashMap<>();
        layers.put("board", new ArrayList<>());
        layers.put("video", new ArrayList<>());
        state.put("layers", layers);
    }

    public int getPort() { return port; }

    public synchronized void start() throws IOException {
        if (running) return;
        serverSocket = new ServerSocket();
        serverSocket.setReuseAddress(true);
        serverSocket.bind(new InetSocketAddress(port));
        running = true;
        Thread t = new Thread(() -> {
            while (running) {
                try {
                    final Socket s = serverSocket.accept();
                    Thread h = new Thread(() -> handle(s), "bl-conn");
                    h.setDaemon(true);
                    h.start();
                } catch (IOException e) {
                    if (!running) break;
                }
            }
        }, "bl-accept");
        t.setDaemon(true);
        t.start();
    }

    public synchronized void stop() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) { }
        synchronized (lock) { for (Client c : new ArrayList<>(clients.values())) c.kill(); }
    }

    /* ======================================================== state ===== */

    @SuppressWarnings("unchecked")
    private boolean apply(Map<String, Object> ev) {
        Object tObj = ev.get("t");
        if (!(tObj instanceof String)) return false;
        String t = (String) tObj;
        Map<String, Object> layers = (Map<String, Object>) state.get("layers");
        Object layerName = ev.get("layer");
        Object lo = layerName instanceof String ? layers.get(layerName) : null;
        List<Object> L = lo instanceof List ? (List<Object>) lo : null;
        if (LAYER_EVENTS.contains(t) && L == null) return false;
        switch (t) {
            case "begin":
            case "add": {
                Object o = ev.get("obj");
                if (!(o instanceof Map) || ((Map<String, Object>) o).get("id") == null) return false;
                Object c = Json.copy(o);
                Object idx = ev.get("index");
                if (idx instanceof Number) {
                    int i = ((Number) idx).intValue();
                    if (i >= 0 && i <= L.size()) { L.add(i, c); return true; }
                }
                L.add(c);
                return true;
            }
            case "pts": {
                int i = find(L, ev.get("id"));
                Object p = ev.get("pts");
                if (i < 0 || !(p instanceof List)) return false;
                Object arr = ((Map<String, Object>) L.get(i)).get("pts");
                if (!(arr instanceof List)) return false;
                ((List<Object>) arr).addAll((List<Object>) p);
                return true;
            }
            case "end": return true;
            case "update": {
                int i = find(L, ev.get("id"));
                if (i < 0) return false;
                Object patch = ev.get("patch");
                if (patch instanceof Map) ((Map<String, Object>) L.get(i)).putAll((Map<String, Object>) Json.copy(patch));
                return true;
            }
            case "remove": {
                int i = find(L, ev.get("id"));
                if (i >= 0) L.remove(i);
                return true;
            }
            case "clear": L.clear(); return true;
            case "restore": {
                Object objs = ev.get("objects");
                layers.put((String) layerName, objs instanceof List ? Json.copy(objs) : new ArrayList<>());
                return true;
            }
            case "bg": {
                Object v = ev.get("value");
                if ("white".equals(v) || "dark".equals(v) || "grid".equals(v) || "lines".equals(v)) { state.put("bg", v); return true; }
                return false;
            }
            case "mode": {
                Object m = ev.get("mode");
                if ("menu".equals(m) || "board".equals(m) || "video".equals(m)) state.put("mode", m);
                Object a = ev.get("videoAspect");
                if (a instanceof Number && ((Number) a).doubleValue() > 0.2 && ((Number) a).doubleValue() < 5) state.put("videoAspect", a);
                return true;
            }
            case "video":
            case "vstate":
                return true;
            default:
                return false;
        }
    }

    @SuppressWarnings("unchecked")
    private static int find(List<Object> L, Object id) {
        if (id == null) return -1;
        for (int i = L.size() - 1; i >= 0; i--) {
            Object o = L.get(i);
            if (o instanceof Map && id.equals(((Map<String, Object>) o).get("id"))) return i;
        }
        return -1;
    }

    /* ====================================================== clients ===== */

    private final class Client implements Runnable {
        final String cid, role;
        final Socket sock;
        final OutputStream out;
        final LinkedBlockingQueue<byte[]> queue = new LinkedBlockingQueue<>();
        volatile boolean dead;

        Client(String cid, String role, Socket sock, OutputStream out) { this.cid = cid; this.role = role; this.sock = sock; this.out = out; }

        void send(byte[] b) {
            if (dead) return;
            if (queue.size() > 5000) { kill(); return; } // the other side stopped reading
            queue.offer(b);
        }

        @Override public void run() {
            try {
                while (!dead) {
                    byte[] b = queue.poll(15, TimeUnit.SECONDS);
                    out.write(b == null ? PING : b);
                    out.flush();
                }
            } catch (Exception ignored) { }
            kill();
        }

        void kill() {
            if (dead) return;
            dead = true;
            try { sock.close(); } catch (IOException ignored) { }
            synchronized (lock) {
                if (clients.get(cid) == this) {
                    clients.remove(cid);
                    broadcastLocked(Collections.<Object>singletonList(presence()), null);
                }
            }
        }
    }

    private Map<String, Object> presence() {
        int tablets = 0, pcs = 0;
        for (Client c : clients.values()) { if ("tablet".equals(c.role)) tablets++; else pcs++; }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "presence");
        m.put("tablets", tablets);
        m.put("pcs", pcs);
        return m;
    }

    private Map<String, Object> aiInfo() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("t", "ai");
        m.put("provider", "anthropic");
        m.put("ready", !store.get("apiKey", "").isEmpty());
        m.put("model", store.get("model", DEFAULT_MODEL));
        return m;
    }

    private static byte[] sse(List<Object> events) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("events", events);
        return ("data: " + Json.stringify(m) + "\n\n").getBytes(UTF8);
    }

    /** must hold lock */
    private void broadcastLocked(List<Object> events, String exceptCid) {
        byte[] b = sse(events);
        for (Client c : clients.values()) if (!c.cid.equals(exceptCid)) c.send(b);
    }

    /* ========================================================= http ===== */

    private static final class Request {
        String method, path, query;
        Map<String, String> headers = new LinkedHashMap<>();
        byte[] body = new byte[0];

        String param(String name) {
            if (query == null) return null;
            for (String part : query.split("&")) {
                int eq = part.indexOf('=');
                String k = eq < 0 ? part : part.substring(0, eq);
                if (k.equals(name)) {
                    try { return java.net.URLDecoder.decode(eq < 0 ? "" : part.substring(eq + 1), "UTF-8"); } catch (Exception e) { return null; }
                }
            }
            return null;
        }
    }

    private static Request readRequest(InputStream in) throws IOException, HttpError {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int state = 0, b;
        while (true) {
            b = in.read();
            if (b < 0) return null;
            head.write(b);
            if (head.size() > 32768) throw new HttpError(431, "Headers too large");
            if (b == '\r' && (state == 0 || state == 2)) state++;
            else if (b == '\n' && (state == 1 || state == 3)) { state++; if (state == 4) break; }
            else state = 0;
        }
        String[] lines = new String(head.toByteArray(), LATIN1).split("\r\n");
        String[] first = lines[0].split(" ");
        if (first.length < 2) throw new HttpError(400, "Bad request");
        Request r = new Request();
        r.method = first[0].toUpperCase(Locale.ROOT);
        String target = first[1];
        int q = target.indexOf('?');
        r.path = q < 0 ? target : target.substring(0, q);
        r.query = q < 0 ? null : target.substring(q + 1);
        for (int i = 1; i < lines.length; i++) {
            int c = lines[i].indexOf(':');
            if (c > 0) r.headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
        }
        String cl = r.headers.get("content-length");
        if (cl != null) {
            int n;
            try { n = Integer.parseInt(cl); } catch (NumberFormatException e) { throw new HttpError(400, "Bad length"); }
            if (n > 40 * 1024 * 1024) throw new HttpError(413, "Too large");
            byte[] body = new byte[n];
            int off = 0;
            while (off < n) {
                int k = in.read(body, off, n - off);
                if (k < 0) throw new IOException("Body ended early");
                off += k;
            }
            r.body = body;
        }
        return r;
    }

    private static void respond(OutputStream out, int status, String type, byte[] body, String extraHeaders) throws IOException {
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        if (type != null) h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Cache-Control: no-cache\r\n");
        if (extraHeaders != null) h.append(extraHeaders);
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes(LATIN1));
        out.write(body);
        out.flush();
    }

    private static void respondJson(OutputStream out, int status, Object obj) throws IOException {
        respond(out, status, "application/json; charset=utf-8", Json.stringify(obj).getBytes(UTF8), null);
    }

    private static String reason(int s) {
        switch (s) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 413: return "Payload Too Large";
            case 415: return "Unsupported Media Type";
            case 502: return "Bad Gateway";
            default: return "Error";
        }
    }

    private static Map<String, Object> obj(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    private void handle(Socket sock) {
        OutputStream out = null;
        try {
            sock.setTcpNoDelay(true);
            sock.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            out = sock.getOutputStream();
            Request req = readRequest(in);
            if (req == null) { sock.close(); return; }
            if ("GET".equals(req.method) && "/api/stream".equals(req.path)) { stream(sock, in, out, req); return; }
            route(req, out);
        } catch (HttpError e) {
            try { if (out != null) respondJson(out, e.status, obj("error", e.getMessage())); } catch (IOException ignored) { }
        } catch (Exception e) {
            try { if (out != null) respondJson(out, 500, obj("error", String.valueOf(e.getMessage()))); } catch (IOException ignored) { }
        }
        try { sock.close(); } catch (IOException ignored) { }
    }

    private void stream(Socket sock, InputStream in, OutputStream out, Request req) throws IOException {
        String cid = req.param("cid");
        if (cid == null || cid.isEmpty()) cid = "c" + random.nextInt(Integer.MAX_VALUE);
        if (cid.length() > 40) cid = cid.substring(0, 40);
        String role = "tablet".equals(req.param("role")) ? "tablet" : "pc";
        sock.setSoTimeout(0);
        String head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\n"
            + "Access-Control-Allow-Origin: *\r\nConnection: keep-alive\r\n\r\nretry: 1500\n\n";
        Client c = new Client(cid, role, sock, out);
        synchronized (lock) {
            Client old = clients.get(cid);
            clients.put(cid, c);
            if (old != null) old.kill();
            List<Object> hello = new ArrayList<>();
            hello.add(obj("t", "hello", "state", Json.copy(state)));
            hello.add(info());
            hello.add(aiInfo());
            hello.add(presence());
            c.send(head.getBytes(UTF8));
            c.send(sse(hello));
            broadcastLocked(Collections.<Object>singletonList(presence()), cid);
        }
        Thread w = new Thread(c, "bl-sse");
        w.setDaemon(true);
        w.start();
        try { while (in.read() >= 0) { /* browsers do not send anything; -1 means closed */ } } catch (IOException ignored) { }
        c.kill();
    }

    @SuppressWarnings("unchecked")
    private void route(Request req, OutputStream out) throws Exception {
        String p = req.path;
        if ("OPTIONS".equals(req.method)) {
            respond(out, 204, null, new byte[0], "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Access-Control-Allow-Headers: Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\n");
            return;
        }
        if ("POST".equals(req.method) && "/api/events".equals(p)) {
            Object parsed = Json.parse(new String(req.body, UTF8));
            if (!(parsed instanceof Map)) throw new HttpError(400, "Bad JSON");
            Map<String, Object> body = (Map<String, Object>) parsed;
            Object evs = body.get("events");
            String cid = body.get("cid") instanceof String ? (String) body.get("cid") : "";
            if (evs instanceof List) {
                synchronized (lock) {
                    List<Object> ok = new ArrayList<>();
                    for (Object ev : (List<Object>) evs) if (ev instanceof Map && apply((Map<String, Object>) ev)) ok.add(ev);
                    if (!ok.isEmpty()) broadcastLocked(ok, cid);
                }
            }
            respondJson(out, 200, obj("ok", true));
            return;
        }
        if ("POST".equals(req.method) && "/api/upload".equals(p)) {
            String type = req.headers.get("content-type");
            if (type == null || !type.matches("image/(png|jpeg|webp|gif)")) throw new HttpError(415, "Images only");
            String id = Long.toHexString(random.nextLong() & Long.MAX_VALUE) + Long.toHexString(System.nanoTime());
            images.put(id, new Image(req.body, type));
            respondJson(out, 200, obj("src", "/img/" + id));
            return;
        }
        if ("POST".equals(req.method) && "/api/ai".equals(p)) {
            Object parsed = Json.parse(new String(req.body, UTF8));
            if (!(parsed instanceof Map)) throw new HttpError(400, "Bad JSON");
            String text = askAI((Map<String, Object>) parsed);
            respondJson(out, 200, obj("text", text.isEmpty() ? "(empty answer)" : text));
            return;
        }
        if ("POST".equals(req.method) && "/api/settings".equals(p)) {
            Object parsed = Json.parse(new String(req.body, UTF8));
            if (parsed instanceof Map) {
                Map<String, Object> m = (Map<String, Object>) parsed;
                if (m.get("apiKey") instanceof String) store.put("apiKey", ((String) m.get("apiKey")).trim());
                if (m.get("model") instanceof String && !((String) m.get("model")).trim().isEmpty()) store.put("model", ((String) m.get("model")).trim());
            }
            synchronized (lock) { broadcastLocked(Collections.<Object>singletonList(aiInfo()), null); }
            respondJson(out, 200, settingsView());
            return;
        }
        if (!"GET".equals(req.method) && !"HEAD".equals(req.method)) { respond(out, 405, "text/plain", new byte[0], null); return; }
        if ("/api/settings".equals(p)) { respondJson(out, 200, settingsView()); return; }
        if ("/api/info".equals(p)) { Map<String, Object> m = info(); synchronized (lock) { m.put("presence", presence()); } respondJson(out, 200, m); return; }
        if (p.startsWith("/img/")) {
            Image im = images.get(p.substring(5));
            if (im == null) { respond(out, 404, "text/plain", new byte[0], null); return; }
            respond(out, 200, im.type, im.data, null);
            return;
        }
        String file;
        if ("/".equals(p) || "/pc".equals(p) || "/pc/".equals(p)) file = "pc.html";
        else if ("/tablet".equals(p) || "/tablet/".equals(p)) file = "tablet.html";
        else file = p.substring(1);
        if (file.contains("..") || file.startsWith("/")) { respond(out, 403, "text/plain", new byte[0], null); return; }
        byte[] data;
        try { data = assets.read(file); } catch (IOException e) { respond(out, 404, "text/plain; charset=utf-8", "Not found".getBytes(UTF8), null); return; }
        respond(out, 200, mime(file), data, null);
    }

    private Map<String, Object> settingsView() {
        String key = store.get("apiKey", "");
        return obj("hasKey", !key.isEmpty(), "keyHint", key.length() > 8 ? "…" + key.substring(key.length() - 4) : "",
            "model", store.get("model", DEFAULT_MODEL));
    }

    private static String mime(String f) {
        String n = f.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    /** IPv4 addresses of this tablet (USB tethering, Wi-Fi...) */
    public Map<String, Object> info() {
        List<Object> list = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs != null && ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    String name = ni.getName();
                    String kind = name.startsWith("rndis") || name.startsWith("usb") || name.startsWith("ncm") ? "cable"
                        : name.startsWith("wlan") || name.startsWith("ap") || name.startsWith("swlan") ? "wifi" : "other";
                    list.add(obj("name", name, "kind", kind, "addr", a.getHostAddress()));
                }
            }
        } catch (Exception ignored) { }
        // cable first, then wifi
        List<Object> sorted = new ArrayList<>();
        for (String k : new String[]{"cable", "wifi", "other"})
            for (Object o : list) if (k.equals(((Map<?, ?>) o).get("kind"))) sorted.add(o);
        return obj("t", "info", "port", port, "ips", sorted);
    }

    /* =========================================================== AI ===== */

    @SuppressWarnings("unchecked")
    private String askAI(Map<String, Object> body) throws Exception {
        String key = store.get("apiKey", "");
        if (key.isEmpty())
            throw new HttpError(400, "The AI is not set up yet. Tap Settings (gear) on the tablet, or AI settings on the PC menu, and paste your Claude API key.");
        List<Map<String, Object>> msgs = new ArrayList<>();
        Object raw = body.get("messages");
        if (raw instanceof List) {
            List<Object> all = (List<Object>) raw;
            for (Object o : all.subList(Math.max(0, all.size() - 24), all.size())) {
                if (!(o instanceof Map)) continue;
                Map<String, Object> m = (Map<String, Object>) o;
                Object role = m.get("role"), content = m.get("content");
                if (!("user".equals(role) || "assistant".equals(role)) || !(content instanceof String) || ((String) content).trim().isEmpty()) continue;
                String text = (String) content;
                if (text.length() > 8000) text = text.substring(0, 8000);
                Map<String, Object> last = msgs.isEmpty() ? null : msgs.get(msgs.size() - 1);
                if (last != null && role.equals(last.get("role"))) last.put("content", last.get("content") + "\n\n" + text);
                else msgs.add(obj("role", role, "content", text));
            }
        }
        while (!msgs.isEmpty() && !"user".equals(msgs.get(0).get("role"))) msgs.remove(0);
        if (msgs.isEmpty() || !"user".equals(msgs.get(msgs.size() - 1).get("role"))) throw new HttpError(400, "Nothing to send.");

        Object img = body.get("image");
        if (img instanceof String && ((String) img).matches("(?s)^data:image/(png|jpeg|webp);base64,.*")) {
            String s = (String) img;
            int comma = s.indexOf(',');
            String media = s.substring(5, s.indexOf(';'));
            Map<String, Object> last = msgs.get(msgs.size() - 1);
            List<Object> blocks = new ArrayList<>();
            blocks.add(obj("type", "image", "source", obj("type", "base64", "media_type", media, "data", s.substring(comma + 1))));
            blocks.add(obj("type", "text", "text", last.get("content")));
            last.put("content", blocks);
        }

        Map<String, Object> payload = obj("model", store.get("model", DEFAULT_MODEL), "max_tokens", 1024, "system", SYSTEM_PROMPT, "messages", msgs);
        HttpURLConnection c;
        int code;
        String resp;
        try {
            c = (HttpURLConnection) new URL("https://api.anthropic.com/v1/messages").openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(15000);
            c.setReadTimeout(90000);
            c.setRequestProperty("content-type", "application/json");
            c.setRequestProperty("x-api-key", key);
            c.setRequestProperty("anthropic-version", "2023-06-01");
            OutputStream o = c.getOutputStream();
            o.write(Json.stringify(payload).getBytes(UTF8));
            o.close();
            code = c.getResponseCode();
            InputStream is = code >= 400 ? c.getErrorStream() : c.getInputStream();
            resp = is == null ? "" : new String(readAll(is), UTF8);
        } catch (IOException e) {
            throw new HttpError(502, "Could not reach the Claude API. The tablet needs an internet connection (Wi-Fi or mobile data) for the AI.");
        }
        Object parsed;
        try { parsed = Json.parse(resp); } catch (Exception e) { parsed = null; }
        if (code != 200) {
            String msg = "HTTP " + code;
            if (parsed instanceof Map && ((Map<String, Object>) parsed).get("error") instanceof Map) {
                Object m = ((Map<String, Object>) ((Map<String, Object>) parsed).get("error")).get("message");
                if (m != null) msg = String.valueOf(m);
            }
            throw new HttpError(502, "Claude API error: " + msg);
        }
        StringBuilder sb = new StringBuilder();
        if (parsed instanceof Map && ((Map<String, Object>) parsed).get("content") instanceof List)
            for (Object b : (List<Object>) ((Map<String, Object>) parsed).get("content"))
                if (b instanceof Map && "text".equals(((Map<String, Object>) b).get("type"))) sb.append(((Map<String, Object>) b).get("text"));
        return sb.toString().trim();
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return bo.toByteArray();
    }
}
