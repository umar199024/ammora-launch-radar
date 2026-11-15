import {
  createPublicClient, createWalletClient, custom, http, defineChain,
  formatUnits, parseUnits, erc20Abi, parseAbi,
} from 'viem';
import {
  AmmoraV4LaunchCurveClient, classifyAmmoraV4ExactInputFill, giwaSepoliaAutoRoute,
} from '@ammora-protocol/sdk';

// ---------- chain + SDK wiring ----------
const RPC = 'https://sepolia-rpc.giwa.io';
const EXPLORER = 'https://sepolia-explorer.giwa.io';
const giwa = defineChain({
  id: 91342, name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: EXPLORER } },
});
const pub = createPublicClient({ chain: giwa, transport: http(RPC, { retryCount: 6, retryDelay: 350 }) });

const FACTORY = giwaSepoliaAutoRoute.factories.find((f) => f.kind === 'dbc');
const CORE = {
  launchFactory: FACTORY.address,
  feePolicy: FACTORY.bindings.find((b) => b.name === 'feePolicy').address,
};
const WETH_ABI = parseAbi(['function deposit() payable', 'function balanceOf(address) view returns (uint256)']);

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmt = (v, d = 18, max = 6) => {
  const n = Number(formatUnits(v, d));
  if (n === 0) return '0';
  if (n < 1e-6) return '<0.000001';
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? max : 2 });
};
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, ms = 3800) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---------- state ----------
let launches = [];
let filter = 'all';
let account = null;
let wallet = null;

// ---------- discovery (factory LaunchCreated events via GIWA explorer) ----------
async function fetchLaunchEvents() {
  const out = new Map();
  let url = `${EXPLORER}/api/v2/addresses/${FACTORY.address}/logs`;
  for (let page = 0; page < 6 && url; page++) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Explorer ${r.status}`);
    const j = await r.json();
    for (const it of j.items || []) {
      const d = it.decoded; if (!d) continue;
      const p = Object.fromEntries((d.parameters || []).map((x) => [x.name, x.value]));
      const curve = p.curve?.toLowerCase(); if (!curve) continue;
      const rec = out.get(curve) || { curve: p.curve, block: it.block_number, time: it.block_timestamp, tx: it.transaction_hash };
      if (d.method_call.startsWith('LaunchCreated')) { rec.token = p.token; rec.creator = p.creator; rec.configId = p.configId; }
      if (d.method_call.startsWith('LaunchMetadataConfigured')) rec.metaURI = p.creatorMetadataURI;
      out.set(curve, rec);
    }
    const n = j.next_page_params;
    url = n ? `${EXPLORER}/api/v2/addresses/${FACTORY.address}/logs?${new URLSearchParams(n)}` : null;
  }
  return [...out.values()].filter((x) => x.token).sort((a, b) => b.block - a.block);
}

function parseMeta(uri) {
  try {
    if (uri?.startsWith('data:application/json;base64,')) return JSON.parse(atob(uri.split(',')[1]));
  } catch {}
  return {};
}

// ---------- on-chain reads through the Ammora SDK ----------
async function tokenInfo(addr) {
  try {
    const r = await fetch(`${EXPLORER}/api/v2/tokens/${addr}`);
    if (r.ok) { const j = await r.json(); return { name: j.name || 'Unnamed', symbol: j.symbol || '???', decimals: Number(j.decimals ?? 18), holders: j.holders_count ?? j.holders ?? null }; }
  } catch {}
  const [name, symbol, decimals] = await Promise.all([
    pub.readContract({ address: addr, abi: erc20Abi, functionName: 'name' }).catch(() => 'Unnamed'),
    pub.readContract({ address: addr, abi: erc20Abi, functionName: 'symbol' }).catch(() => '???'),
    pub.readContract({ address: addr, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
  ]);
  return { name, symbol, decimals: Number(decimals), holders: null };
}

async function hydrate(l) {
  const sdk = new AmmoraV4LaunchCurveClient(pub, l.curve, CORE);
  const [info, state] = await Promise.all([tokenInfo(l.token), sdk.getState()]);
  const meta = parseMeta(l.metaURI);
  const migrated = state.status === 3;
  const ready = state.status === 2;
  const kind = migrated ? 'grad' : ready ? 'ready' : state.status === 1 ? 'live' : 'wait';
  const t = state.migrationQuoteThreshold;
  const pct = migrated ? 100 : t > 0n ? Math.min(100, Number((state.quoteReserve * 1000000n) / t) / 10000) : 0;
  return { ...l, ...info, sdk, state, meta, kind, pct, price: null };
}

async function loadPrice(l) {
  if (l.kind !== 'live' || l.price !== null) return;
  try {
    const q = await l.sdk.quoteExactInput(parseUnits('0.0001', 18), false);
    l.price = q.amountOut > 0n ? Number(formatUnits(q.amountIn, 18)) / Number(formatUnits(q.amountOut, l.decimals)) : 0;
  } catch { l.price = 0; }
}

const LABEL = { live: ['Trading', 'b-live'], ready: ['Ready to graduate', 'b-ready'], grad: ['Graduated', 'b-grad'], wait: ['Not active', 'b-wait'] };

function avatar(l) {
  const img = l.meta?.image && /^https?:|^ipfs:/.test(l.meta.image) ? l.meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/') : null;
  const h = hue(l.token);
  return `<div class="av" style="background:linear-gradient(135deg,hsl(${h} 80% 60%),hsl(${(h + 60) % 360} 80% 55%))">${img ? `<img src="${esc(img)}" alt="" onerror="this.remove()">` : esc(l.symbol.slice(0, 2).toUpperCase())}</div>`;
}

function render() {
  const rows = launches.filter((l) => filter === 'all' || (filter === 'live' ? l.kind === 'live' || l.kind === 'ready' : l.kind === 'grad'));
  $('s-total').textContent = launches.length;
  $('s-live').textContent = launches.filter((l) => l.kind === 'live' || l.kind === 'ready').length;
  $('s-grad').textContent = launches.filter((l) => l.kind === 'grad').length;
  if (!rows.length) { $('list').innerHTML = `<div class="empty">${launches.length ? 'Nothing in this filter yet.' : 'No launches found.'}</div>`; return; }
  $('list').innerHTML = rows.map((l, i) => {
    const [lab, cls] = LABEL[l.kind];
    return `<div class="card" data-i="${launches.indexOf(l)}">
      <div class="row"><div class="tok">${avatar(l)}<div><b>${esc(l.name)}</b><small>$${esc(l.symbol)} · ${short(l.token)}</small></div></div><span class="badge ${cls}">${lab}</span></div>
      <div class="bar"><i style="width:${l.pct}%"></i></div>
      <div class="meta">
        <div><b>${l.pct.toFixed(l.pct < 10 ? 2 : 0)}%</b>to graduate</div>
        <div><b>${fmt(l.state.quoteReserve)} ETH</b>raised</div>
        <div><b>${l.holders ?? '—'}</b>holders</div>
      </div>
    </div>`;
  }).join('');
  document.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => openDetail(launches[+c.dataset.i])));
}

let pending = 0;
async function load() {
  $('list').innerHTML = '<div class="empty">Scanning the Ammora factory on GIWA…</div>';
  try {
    pub.getBlockNumber().then((b) => ($('s-block').textContent = Number(b).toLocaleString())).catch(() => {});
    const evs = await fetchLaunchEvents();
    $('s-total').textContent = evs.length;
    launches = [];
    pending = evs.length;
    $('list').innerHTML = `<div class="empty">Found ${evs.length} launches. Reading each curve live with the Ammora SDK…</div>`;
    await pool(evs, 3, async (ev) => {
      try { launches.push(await hydrate(ev)); launches.sort((a, b) => b.block - a.block); render(); }
      finally { pending--; renderProgress(); }
    });
    render();
  } catch (e) {
    console.error(e);
    $('list').innerHTML = `<div class="empty">Couldn't reach GIWA right now (${esc(e.message)}). Hit refresh in a moment.</div>`;
  }
}
function renderProgress() {
  const el = $('refresh');
  el.textContent = pending > 0 ? `Loading ${pending}…` : '↻ Refresh';
  el.disabled = pending > 0;
}

async function pool(items, n, fn) {
  const res = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { res[k] = { status: 'fulfilled', value: await fn(items[k]) }; } catch (e) { res[k] = { status: 'rejected', reason: e }; } }
  }));
  return res;
}

// ---------- detail + trade ----------
let side = 'buy';
let current = null;

function openDetail(l) {
  current = l; side = 'buy';
  const [lab, cls] = LABEL[l.kind];
  const s = l.state;
  const tradable = l.kind === 'live';
  $('detail').innerHTML = `
    <div class="row"><div class="tok">${avatar(l)}<div><b>${esc(l.name)}</b><small>$${esc(l.symbol)}</small></div></div><span class="badge ${cls}">${lab}</span></div>
    ${l.meta?.description ? `<p class="note">${esc(l.meta.description)}</p>` : ''}
    <div class="bar"><i style="width:${l.pct}%"></i></div>
    <div class="kv">
      <div><span>Raised / target</span>${fmt(s.quoteReserve)} / ${fmt(s.migrationQuoteThreshold)} ETH</div>
      <div><span>Trading fee</span>${(s.currentFeeBps / 100).toFixed(2)}%</div>
      <div><span>Tokens left on curve</span>${fmt(s.baseReserve, l.decimals)}</div>
      <div><span>Launched</span>${new Date(l.time).toLocaleDateString()}</div>
      <div><span>Price</span><b id="px">${l.kind === 'live' ? 'loading…' : '—'}</b></div>
      <div><span>Holders</span>${l.holders ?? '—'}</div>
    </div>
    ${tradable ? `
    <div class="tabs"><button id="t-buy" class="on">Buy</button><button id="t-sell" class="sell">Sell</button></div>
    <div class="inp"><input id="amt" inputmode="decimal" placeholder="0.0" value="0.001"><span id="unit">WETH</span></div>
    <div class="quote" id="quote">Enter an amount to get a live quote.</div>
    <button class="btn full" id="go">${account ? 'Buy' : 'Connect wallet to trade'}</button>
    <ol class="steps" id="steps"></ol>
    <p class="note">Buys are paid in WETH on GIWA Sepolia. If you only hold ETH, the app wraps exactly what's needed first. 1% max slippage.</p>`
    : l.kind === 'grad'
      ? `<p class="note">This token finished its bonding curve and graduated into an Ammora liquidity pool. Trade it on <a href="https://ammora.org" target="_blank" rel="noopener">Ammora</a>.</p>`
      : `<p class="note">This curve isn't open for curve trades right now.</p>`}
    <div class="links">
      <a href="${EXPLORER}/token/${l.token}" target="_blank" rel="noopener">Token ↗</a>
      <a href="${EXPLORER}/address/${l.curve}" target="_blank" rel="noopener">Curve ↗</a>
      <a href="${EXPLORER}/tx/${l.tx}" target="_blank" rel="noopener">Launch tx ↗</a>
      <a href="${EXPLORER}/address/${l.creator}" target="_blank" rel="noopener">Creator ${short(l.creator)} ↗</a>
    </div>`;
  $('modal').hidden = false;
  loadPrice(l).then(() => { const px = $('px'); if (px && current === l) px.textContent = l.price ? `${l.price.toExponential(3)} ETH` : '—'; });
  if (tradable) {
    $('t-buy').onclick = () => setSide('buy');
    $('t-sell').onclick = () => setSide('sell');
    $('amt').oninput = debounce(requote, 350);
    $('go').onclick = () => (account ? trade() : connect());
    requote();
  }
}

function setSide(s) {
  side = s;
  $('t-buy').classList.toggle('on', s === 'buy');
  $('t-sell').classList.toggle('on', s === 'sell');
  $('unit').textContent = s === 'buy' ? 'WETH' : `$${current.symbol}`;
  $('go').textContent = account ? (s === 'buy' ? 'Buy' : 'Sell') : 'Connect wallet to trade';
  requote();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function amountIn() {
  const v = $('amt').value.trim();
  if (!v || Number(v) <= 0) return null;
  try { return parseUnits(v, side === 'buy' ? 18 : current.decimals); } catch { return null; }
}

async function requote() {
  const l = current; const a = amountIn();
  if (!a) { $('quote').textContent = 'Enter an amount to get a live quote.'; return; }
  $('quote').textContent = 'Quoting with the Ammora SDK…';
  try {
    const baseForQuote = side === 'sell';
    const q = await l.sdk.quoteExactInput(a, baseForQuote);
    const fill = classifyAmmoraV4ExactInputFill(q, baseForQuote);
    const outD = baseForQuote ? 18 : l.decimals; const inD = baseForQuote ? l.decimals : 18;
    const outSym = baseForQuote ? 'WETH' : `$${l.symbol}`;
    let extra = '';
    if (fill.kind === 'graduation-boundary') extra = `<br>This buy completes the curve. ${fmt(q.amountLeft, inD)} is refunded and the token graduates.`;
    if (fill.kind === 'terminal-dust' || q.amountOut === 0n) extra = '<br>Amount too small for this curve.';
    $('quote').innerHTML = `You get about <b>${fmt(q.amountOut, outD)} ${outSym}</b> · fee ${fmt(q.fee, inD)} ${baseForQuote ? '$' + esc(l.symbol) : 'WETH'}${extra}`;
  } catch (e) {
    $('quote').textContent = side === 'sell' ? 'No sell route yet: this curve may need its first buy.' : `Quote failed: ${e.shortMessage || e.message}`.slice(0, 160);
  }
}

function setSteps(list, now) {
  $('steps').innerHTML = list.map((s, i) => `<li class="${i < now ? 'done' : i === now ? 'now' : ''}">${s}</li>`).join('');
}

async function send(tx) {
  const hash = await wallet.sendTransaction({ account, chain: giwa, to: tx.to, data: tx.data, value: tx.value ?? 0n });
  toast(`Sent ${short(hash)}. Waiting for confirmation…`);
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error('Transaction reverted');
  return rc;
}

async function trade() {
  const l = current; const a = amountIn(); if (!a) return toast('Enter an amount first');
  const go = $('go'); go.disabled = true;
  const baseForQuote = side === 'sell';
  const steps = [];
  try {
    await ensureChain();
    const q = await l.sdk.quoteExactInput(a, baseForQuote);
    const fill = classifyAmmoraV4ExactInputFill(q, baseForQuote);
    if (fill.kind === 'terminal-dust' || q.amountOut === 0n) throw new Error('Amount too small for this curve');
    const plan = await l.sdk.planSwapExactInput({
      includedAmountIn: a, baseForQuote, allowPartialFill: fill.allowPartialFill, slippageBps: 100,
      recipient: account, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    });
    const todo = [];
    if (!baseForQuote) {
      const bal = await pub.readContract({ address: l.state.quoteToken, abi: WETH_ABI, functionName: 'balanceOf', args: [account] });
      if (bal < a) todo.push({ label: `Wrap ${fmt(a - bal)} ETH → WETH`, tx: { to: l.state.quoteToken, data: encodeDeposit(), value: a - bal } });
    } else {
      const bal = await pub.readContract({ address: l.token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
      if (bal < a) throw new Error(`You hold ${fmt(bal, l.decimals)} $${l.symbol}`);
    }
    for (const req of plan.approvalRequirements) {
      const cur = await pub.readContract({ address: req.token, abi: erc20Abi, functionName: 'allowance', args: [account, req.spender] });
      if (cur < req.amount) todo.push({ label: `Approve ${baseForQuote ? '$' + l.symbol : 'WETH'}`, approve: req });
    }
    todo.push({ label: `${baseForQuote ? 'Sell' : 'Buy'} on the Ammora curve`, tx: plan.transaction });
    todo.forEach((t) => steps.push(t.label));
    for (let i = 0; i < todo.length; i++) {
      setSteps(steps, i);
      const t = todo[i];
      if (t.approve) {
        const hash = await wallet.writeContract({ account, chain: giwa, address: t.approve.token, abi: erc20Abi, functionName: 'approve', args: [t.approve.spender, t.approve.amount] });
        toast(`Approval sent ${short(hash)}…`);
        await pub.waitForTransactionReceipt({ hash });
      } else {
        const rc = await send(t.tx);
        if (i === todo.length - 1) toast(`Done ✅ ${baseForQuote ? 'Sold' : 'Bought'} $${l.symbol}. Tx ${short(rc.transactionHash)}`, 6000);
      }
    }
    setSteps(steps, steps.length);
    const fresh = await hydrate(l);
    launches[launches.indexOf(l)] = fresh; render();
  } catch (e) {
    console.error(e);
    toast(e.shortMessage || e.message || 'Trade failed', 6000);
  } finally { go.disabled = false; }
}

function encodeDeposit() { return '0xd0e30db0'; } // WETH.deposit()

// ---------- wallet ----------
async function ensureChain() {
  const id = await window.ethereum.request({ method: 'eth_chainId' });
  if (parseInt(id, 16) === giwa.id) return;
  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + giwa.id.toString(16) }] });
  } catch (e) {
    if (e.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
      chainId: '0x' + giwa.id.toString(16), chainName: 'GIWA Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: [EXPLORER] }] });
  }
}

async function connect() {
  if (!window.ethereum) return toast('No wallet found. Open this page in a browser with a wallet like MetaMask or Rabby.');
  try {
    const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = a;
    wallet = createWalletClient({ chain: giwa, transport: custom(window.ethereum) });
    await ensureChain();
    $('connect').textContent = short(a);
    const bal = await pub.getBalance({ address: a });
    $('net').textContent = `GIWA Sepolia · ${fmt(bal)} ETH`;
    if ($('go')) $('go').textContent = side === 'buy' ? 'Buy' : 'Sell';
    window.ethereum.on?.('accountsChanged', (x) => { account = x[0] || null; $('connect').textContent = account ? short(account) : 'Connect wallet'; });
  } catch (e) { toast(e.shortMessage || e.message); }
}

// ---------- events ----------
$('connect').onclick = connect;
$('refresh').onclick = load;
$('close').onclick = () => ($('modal').hidden = true);
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('modal').hidden = true; });
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
  c.classList.add('on'); filter = c.dataset.f; render();
}));
load();
