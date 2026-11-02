/* ============================================================
   sw.js — Service Worker do Painel OCI (PWA · rede-primeiro)
   ------------------------------------------------------------
   QUANDO TROCAR A VERSAO (constante VERSAO abaixo):
   - Mudou SOMENTE o conteúdo dos HTML (regras, OCIs, valores):
     NÃO precisa trocar. A estratégia é rede-primeiro, então a
     próxima abertura com internet já traz o conteúdo novo.
   - Mudou ESTE arquivo (sw.js) OU a lista PRECACHE (arquivos
     pré-carregados): TROQUE a VERSAO antes de publicar, para o
     navegador instalar o worker novo e limpar o cache antigo.
   Formato da VERSAO: 'AAAA-MM-DD.n' (n = 2ª, 3ª troca no dia).
   ============================================================ */
'use strict';

const PREFIXO = 'painel-oci-';
const VERSAO  = '2026-11-02.1';
const CACHE   = PREFIXO + VERSAO;
const LIMITE_REDE = 3500; // ms de espera máxima pela rede nas páginas

const PRECACHE = [
  './',
  './index.html',
  './faturamento.html',
  './manifest.json',
  './icons/favicon.svg',
  './icons/favicon-32.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

// Memória volátil: origem/data da última navegação de cada cliente (aba/app).
const ultimaNav = {}; // { [clientId]: { origem:'rede'|'cache', salvoEm:'ISO' } }

/* ---------- install: pré-carrega e assume logo ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

/* ---------- activate: apaga só caches painel-oci-* antigos ---------- */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(
        nomes
          .filter((n) => n.startsWith(PREFIXO) && n !== CACHE)
          .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

/* ---------- mensagens da página: {tipo:'status'} ---------- */
self.addEventListener('message', (e) => {
  const d = e.data || {};
  if (d.tipo === 'status') {
    const info = (e.source && ultimaNav[e.source.id]) || { origem: 'rede', salvoEm: null };
    if (e.ports && e.ports[0]) e.ports[0].postMessage(info);
  }
});

/* ---------- fetch ---------- */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                         // só GET
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;          // externos passam direto (GoatCounter, DOU, etc.)

  if (ehNavegacao(req)) {
    e.respondWith(estrategiaPagina(e));
  } else {
    e.respondWith(cachePrimeiro(req));
  }
});

function ehNavegacao(req) {
  if (req.mode === 'navigate') return true;
  const aceita = req.headers.get('accept') || '';
  return aceita.includes('text/html');
}

// ./ e ./index.html são a MESMA página no cache: normaliza removendo 'index.html'
function chaveCache(req) {
  const url = new URL(req.url);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/index\.html$/, '');
  return new Request(url.toString());
}

/* Páginas HTML: REDE PRIMEIRO com limite de 3.500 ms.
   - rede a tempo  -> entrega e grava cópia (cabeçalho X-Painel-Salvo-Em)
   - lenta/ausente -> entrega cópia do cache; se a rede voltar, atualiza em 2º plano
   - sem rede e sem cache -> página "sem internet e sem cópia salva" */
async function estrategiaPagina(e) {
  const req = e.request;
  const chave = chaveCache(req);
  const clientId = e.resultingClientId || e.clientId || null;

  let timer;
  const rede = fetch(req).then((r) => { clearTimeout(timer); return r; });
  const espera = new Promise((res) => { timer = setTimeout(() => res('TIMEOUT'), LIMITE_REDE); });

  try {
    const r = await Promise.race([rede, espera]);
    if (r !== 'TIMEOUT' && r && r.ok) {
      await gravar(chave, r.clone());
      registrarNav(clientId, 'rede', agoraISO());
      return r;
    }
    // Rede demorou demais (ou falhou): tenta cache e atualiza em 2º plano.
    rede.then((resp) => { if (resp && resp.ok) gravar(chave, resp.clone()); }).catch(() => {});
    const cache = await caches.match(chave);
    if (cache) {
      registrarNav(clientId, 'cache', salvoEmDe(cache));
      return cache;
    }
    const r2 = await rede.catch(() => null);
    if (r2 && r2.ok) {
      await gravar(chave, r2.clone());
      registrarNav(clientId, 'rede', agoraISO());
      return r2;
    }
    return paginaSemRede();
  } catch (_) {
    const cache = await caches.match(chave);
    if (cache) {
      registrarNav(clientId, 'cache', salvoEmDe(cache));
      return cache;
    }
    return paginaSemRede();
  }
}

/* Demais arquivos da mesma origem (manifest, ícones): cache primeiro, atualiza em 2º plano. */
async function cachePrimeiro(req) {
  const cache = await caches.match(req);
  const buscar = fetch(req).then((resp) => {
    if (resp && resp.ok) caches.open(CACHE).then((c) => c.put(req, resp.clone()));
    return resp;
  }).catch(() => null);
  return cache || (await buscar) || new Response('', { status: 504 });
}

/* Grava no cache uma cópia com o cabeçalho X-Painel-Salvo-Em (data/hora ISO). */
async function gravar(chave, resp) {
  try {
    const corpo = await resp.blob();
    const headers = new Headers(resp.headers);
    headers.set('X-Painel-Salvo-Em', agoraISO());
    const copia = new Response(corpo, { status: resp.status, statusText: resp.statusText, headers });
    const c = await caches.open(CACHE);
    await c.put(chave, copia);
  } catch (_) { /* silencioso */ }
}

function salvoEmDe(resp) {
  try { return resp.headers.get('X-Painel-Salvo-Em'); } catch (_) { return null; }
}
function registrarNav(id, origem, salvoEm) {
  if (id) ultimaNav[id] = { origem, salvoEm };
}
function agoraISO() { return new Date().toISOString(); }

function paginaSemRede() {
  const html = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Sem internet</title><style>body{margin:0;font-family:Segoe UI,system-ui,sans-serif;'
    + 'background:#f4f6fa;color:#1a2233;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}'
    + '.c{max-width:420px;text-align:center;background:#fff;border:1px solid #e2e7f0;border-radius:14px;padding:28px}'
    + 'h1{font-size:18px;color:#1F3864;margin:0 0 10px}p{font-size:14px;line-height:1.5;color:#5a6478;margin:0}</style></head>'
    + '<body><div class="c"><h1>Sem internet e sem cópia salva</h1>'
    + '<p>Abra o painel com internet uma vez para poder usá-lo offline depois.</p></div></body></html>';
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
