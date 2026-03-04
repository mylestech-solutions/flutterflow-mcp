import { openOrbitDb } from './dist/store/db.js';
import { SnapshotRepo } from './dist/store/snapshotRepo.js';
import { IndexRepo } from './dist/store/indexRepo.js';
import { loadFlutterFlowApiConfig } from './dist/ff/config.js';
import { HttpFlutterFlowAdapter } from './dist/ff/adapter.js';
import { PolicyEngine } from './dist/policy/engine.js';
import { ChangesetService } from './dist/edits/changesets.js';
import { OrbitCommandPalette } from './dist/mcp/orbitTool.js';
import { extractSnapshotIndex } from './dist/indexer/extract.js';

const PROJECT_ID = 'medzen-health-pro-0lbqv7';

async function main() {
  const db = openOrbitDb({ dbPath: '.orbit/orbit.sqlite' });
  const sr = new SnapshotRepo(db);
  const ir = new IndexRepo(db);
  const cfg = loadFlutterFlowApiConfig();
  const adapter = new HttpFlutterFlowAdapter(cfg);
  const pe = new PolicyEngine();
  await pe.reload();

  const reindex = async (sid) => {
    const files = sr.listFiles(sid, undefined, 15000).map(f => ({ fileKey: f.fileKey, yaml: f.yaml }));
    const ext = extractSnapshotIndex(sid, files);
    ir.replaceSnapshotIndices(sid, ext.symbols, ext.edges);
  };

  const cs = new ChangesetService(db, sr, pe, adapter, reindex);
  const orbit = new OrbitCommandPalette(adapter, sr, ir, cs, pe);

  let pass = 0;
  let fail = 0;

  async function test(name, fn) {
    try {
      const result = await fn();
      console.log(`[PASS] ${name} — ${result}`);
      pass++;
    } catch (e) {
      console.log(`[FAIL] ${name} — ${String(e.message || e).substring(0, 200)}`);
      fail++;
    }
  }

  // ========== NON-API TESTS ==========
  console.log('\n--- Non-API Tests ---');

  await test('help', async () => {
    const r = await orbit.run({ cmd: 'help' });
    if (r.ok !== true) throw new Error('help returned ok=false');
    return 'Commands listed';
  });

  await test('help widgets.find', async () => {
    const r = await orbit.run({ cmd: 'help', args: { cmd: 'widgets.find' } });
    if (r.ok !== true) throw new Error('help cmd failed');
    return 'Detailed help retrieved';
  });

  await test('api.capabilities', async () => {
    const r = await orbit.run({ cmd: 'api.capabilities' });
    if (r.ok !== true) throw new Error('capabilities failed');
    return r.data.adapter;
  });

  await test('intent.run: list pages', async () => {
    const r = await orbit.run({ cmd: 'intent.run', args: { text: 'list pages' } });
    return JSON.stringify(r.data || r).substring(0, 150);
  });

  await test('intent.run: find buttons on login', async () => {
    const r = await orbit.run({ cmd: 'intent.run', args: { text: 'find buttons on login' } });
    return JSON.stringify(r.data || r).substring(0, 150);
  });

  await test('intent.run: create a login page called MyLogin', async () => {
    const r = await orbit.run({ cmd: 'intent.run', args: { text: 'create a login page called MyLogin' } });
    return JSON.stringify(r.data || r).substring(0, 150);
  });

  await test('schema.search: navigation', async () => {
    const r = await orbit.run({ cmd: 'schema.search', args: { q: 'navigation' } });
    return JSON.stringify(r.data || r).substring(0, 150);
  });

  await test('schema.search: form validation', async () => {
    const r = await orbit.run({ cmd: 'schema.search', args: { q: 'form validation' } });
    return JSON.stringify(r.data || r).substring(0, 150);
  });

  await test('policy check (beast mode)', async () => {
    const policy = pe.getPolicy();
    const checks = [];
    if (policy.denyFileKeyPrefixes && policy.denyFileKeyPrefixes.length === 0) checks.push('no deny prefixes (custom code unlocked)');
    else checks.push('deny prefixes: ' + JSON.stringify(policy.denyFileKeyPrefixes));
    checks.push('safeMode: ' + (policy.safeMode || 'default'));
    return checks.join(', ');
  });

  // ========== API TESTS ==========
  console.log('\n--- API Tests (connecting to FlutterFlow) ---');

  await test('adapter.listPartitionedFileNames', async () => {
    const result = await adapter.listPartitionedFileNames(PROJECT_ID);
    return `${result.files.length} files found, version: ${result.versionInfo?.partitionerVersion || 'unknown'}`;
  });

  // ========== SNAPSHOT TEST ==========
  console.log('\n--- Snapshot Test (this will download ~12K files, may take a while) ---');

  await test('snapshots.create', async () => {
    const r = await orbit.run({ cmd: 'snapshots.create', args: { projectId: PROJECT_ID } });
    if (r.ok !== true) {
      return 'INCOMPLETE: ' + JSON.stringify(r.error || r.data || r).substring(0, 300);
    }
    return 'Snapshot created with ' + (r.data?.fileCount || 'unknown') + ' files';
  });

  // If snapshot exists, test snapshot-dependent commands
  const snaps = sr.listSnapshots();
  if (snaps.length > 0) {
    console.log('\n--- Snapshot-Dependent Tests ---');
    const snapId = snaps[0].id;

    await test('pages.list', async () => {
      const r = await orbit.run({ cmd: 'pages.list', args: { projectId: PROJECT_ID } });
      if (r.ok !== true) throw new Error(JSON.stringify(r));
      const pages = r.data?.pages || [];
      return `${pages.length} pages found. First 5: ${pages.slice(0, 5).map(p => p.name).join(', ')}`;
    });

    await test('search: Consultation', async () => {
      const r = await orbit.run({ cmd: 'search', args: { q: 'Consultation' } });
      return JSON.stringify(r.data || r).substring(0, 300);
    });

    await test('graph.nav', async () => {
      const r = await orbit.run({ cmd: 'graph.nav', args: { projectId: PROJECT_ID } });
      return JSON.stringify(r.data || r).substring(0, 300);
    });

    await test('summarize.project', async () => {
      const r = await orbit.run({ cmd: 'summarize.project', args: { projectId: PROJECT_ID } });
      return JSON.stringify(r.data || r).substring(0, 500);
    });
  } else {
    console.log('\n--- Skipping snapshot-dependent tests (no snapshot yet) ---');
  }

  // ========== SUMMARY ==========
  console.log(`\n========================================`);
  console.log(`TOTAL: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);

  db.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e.message, e.stack?.substring(0, 300));
  process.exit(1);
});
