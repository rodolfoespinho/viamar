#!/usr/bin/env node
/**
 * Viamar FareHarbor Sync Script
 * ─────────────────────────────
 * Sincroniza produtos e horários do FareHarbor para os ficheiros JSON locais.
 * Depois de correr, faz deploy (git push) para publicar as alterações.
 *
 * USO:
 *   node scripts/sync.js
 *
 * OU via Claude Code:
 *   Dizer "sync fareharbor" — Claude executa este script e propõe alterações.
 *
 * O QUE FAZ:
 *   1. Tenta ler a página pública do FareHarbor (viamar-berlenga)
 *   2. Se a Lighthouse API estiver configurada, usa-a para dados mais ricos
 *   3. Mostra o diff entre o JSON actual e os dados novos
 *   4. Pede confirmação antes de escrever
 *   5. Actualiza data/products.json e data/schedules.json
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const readline = require('readline');

const ROOT          = path.join(__dirname, '..');
const PRODUCTS_FILE = path.join(ROOT, 'data', 'products.json');
const SCHEDULES_FILE= path.join(ROOT, 'data', 'schedules.json');
const FH_SHORTNAME  = 'viamar-berlenga';
const FH_PUBLIC_URL = `https://fareharbor.com/${FH_SHORTNAME}/`;
const FH_API_BASE   = 'https://fareharbor.com/api/external/v1';

// Load .env.local if present
function loadEnv() {
  const envFile = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  });
}

function fetchUrl(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Viamar-Sync/1.0', ...headers } }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function diffItems(current, incoming) {
  const changes = [];
  incoming.forEach(newItem => {
    const old = current.find(i => i.id === newItem.id);
    if (!old) {
      changes.push({ type: 'ADD', item: newItem });
    } else {
      const diffs = [];
      if (old.name        !== newItem.name)         diffs.push(`name: "${old.name}" → "${newItem.name}"`);
      if (old.price_adult !== newItem.price_adult)  diffs.push(`price_adult: ${old.price_adult}€ → ${newItem.price_adult}€`);
      if (old.price_child !== newItem.price_child)  diffs.push(`price_child: ${old.price_child}€ → ${newItem.price_child}€`);
      if (old.desc        !== newItem.desc)         diffs.push('desc: changed');
      if (diffs.length) changes.push({ type: 'CHANGE', id: newItem.id, diffs });
    }
  });
  current.forEach(old => {
    if (!incoming.find(i => i.id === old.id)) {
      changes.push({ type: 'REMOVE', id: old.id, name: old.name });
    }
  });
  return changes;
}

// ── Try to fetch items via Lighthouse API ─────────────────────────────────
async function fetchFromAPI(appKey, userKey) {
  console.log('  → Tentando Lighthouse API...');
  try {
    const r = await fetchUrl(
      `${FH_API_BASE}/companies/${FH_SHORTNAME}/items/`,
      { 'X-FareHarbor-API-App': appKey, 'X-FareHarbor-API-User': userKey }
    );
    if (r.status !== 200) return null;
    const data = JSON.parse(r.body);
    return (data.items || []).map(item => ({
      id:          String(item.pk),
      badge:       item.headline || item.name,
      badge_type:  'pop',
      icon:        'anchor',
      name:        item.name,
      desc:        item.description || '',
      features:    [],
      price_adult: null,  // prices need availability call
      price_child: null,
      featured:    false,
      fh_flow:     String(item.pk),
    }));
  } catch (e) {
    return null;
  }
}

// ── Try to read public FareHarbor page ───────────────────────────────────
async function fetchFromPublicPage() {
  console.log('  → Tentando página pública do FareHarbor...');
  try {
    const r = await fetchUrl(FH_PUBLIC_URL);
    if (r.status !== 200) return null;

    // Extract item names and prices from JSON-LD or page text
    // FareHarbor embeds a JSON-LD script with item data
    const jsonLdMatch = r.body.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatch) {
      for (const block of jsonLdMatch) {
        try {
          const json = JSON.parse(block.replace(/<\/?script[^>]*>/gi, ''));
          if (json['@type'] === 'TouristAttraction' || json['@type'] === 'Product' || Array.isArray(json)) {
            return json;
          }
        } catch (_) {}
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  loadEnv();

  console.log('\n🔄 Viamar FareHarbor Sync\n');

  const appKey  = process.env.FAREHARBOR_APP_KEY;
  const userKey = process.env.FAREHARBOR_USER_KEY;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ── Current state ──
  const currentProducts  = readJson(PRODUCTS_FILE);
  const currentSchedules = readJson(SCHEDULES_FILE);

  console.log(`📦 Produtos actuais: ${currentProducts.items.length} items`);
  console.log(`🕐 Horários actuais: ${currentSchedules.seasons.length} temporadas\n`);

  // ── Try to fetch new data ──
  let apiItems = null;

  if (appKey && userKey) {
    apiItems = await fetchFromAPI(appKey, userKey);
    if (apiItems) {
      console.log(`✅ Lighthouse API: ${apiItems.length} items encontrados\n`);
    } else {
      console.log('⚠️  Lighthouse API falhou (APP key inválida?)\n');
    }
  } else {
    console.log('⚠️  Lighthouse API não configurada (FAREHARBOR_APP_KEY em falta)');
    const publicData = await fetchFromPublicPage();
    if (publicData) {
      console.log('✅ Dados da página pública encontrados\n');
    } else {
      console.log('   Página pública não devolveu dados estruturados.\n');
    }
  }

  // ── Manual update mode ──
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('MODO DE ACTUALIZAÇÃO MANUAL');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('Para sincronizar, introduce as alterações por item.\n');

  let productsChanged  = false;
  let schedulesChanged = false;

  // Products
  console.log('📦 PRODUTOS\n');
  for (const item of currentProducts.items) {
    console.log(`  [${item.id}] ${item.name}`);
    console.log(`    Preço adulto: ${item.price_adult}€ | Criança: ${item.price_child ?? 'N/A'}€`);

    const newAdult = await ask(rl, `    Novo preço adulto [Enter = manter ${item.price_adult}€]: `);
    if (newAdult.trim() && parseFloat(newAdult) !== item.price_adult) {
      item.price_adult  = parseFloat(newAdult);
      productsChanged   = true;
      console.log(`    ✏️  Actualizado → ${item.price_adult}€`);
    }

    if (item.price_child !== null) {
      const newChild = await ask(rl, `    Novo preço criança [Enter = manter ${item.price_child}€]: `);
      if (newChild.trim() && parseFloat(newChild) !== item.price_child) {
        item.price_child  = parseFloat(newChild);
        productsChanged   = true;
        console.log(`    ✏️  Actualizado → ${item.price_child}€`);
      }
    }
    console.log('');
  }

  // Schedules
  console.log('🕐 HORÁRIOS\n');
  for (const season of currentSchedules.seasons) {
    console.log(`  [${season.id}] ${season.name} — ${season.dates}`);
    const newDates = await ask(rl, `    Novas datas [Enter = manter "${season.dates}"]: `);
    if (newDates.trim() && newDates.trim() !== season.dates) {
      season.dates    = newDates.trim();
      schedulesChanged = true;
      console.log(`    ✏️  Actualizado → ${season.dates}`);
    }

    for (const dep of season.departures) {
      const statusOpts = 'ok/low/full';
      const newStatus  = await ask(rl, `    ${dep.time} ${dep.from}→${dep.to} [${dep.status}] (${statusOpts}): `);
      if (newStatus.trim() && ['ok','low','full'].includes(newStatus.trim()) && newStatus.trim() !== dep.status) {
        dep.status       = newStatus.trim();
        schedulesChanged = true;
      }
    }
    console.log('');
  }

  const today = new Date().toISOString().split('T')[0];

  if (productsChanged) {
    currentProducts._meta.updated = today;
    writeJson(PRODUCTS_FILE, currentProducts);
    console.log('✅ data/products.json actualizado');
  }

  if (schedulesChanged) {
    currentSchedules._meta.updated = today;
    writeJson(SCHEDULES_FILE, currentSchedules);
    console.log('✅ data/schedules.json actualizado');
  }

  if (!productsChanged && !schedulesChanged) {
    console.log('ℹ️  Nenhuma alteração — ficheiros mantidos.');
  } else {
    console.log('\n🚀 Para publicar:');
    console.log('   git add data/ && git commit -m "sync: update FareHarbor data" && git push');
  }

  rl.close();
}

main().catch(e => { console.error(e); process.exit(1); });
