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
  const times = [];

  async function test(name, fn) {
    const start = Date.now();
    try {
      const result = await fn();
      const ms = Date.now() - start;
      times.push({ name, ms });
      console.log(`[PASS] ${name} (${ms}ms) — ${result}`);
      pass++;
    } catch (e) {
      const ms = Date.now() - start;
      times.push({ name, ms });
      console.log(`[FAIL] ${name} (${ms}ms) — ${String(e.message || e).substring(0, 200)}`);
      fail++;
    }
  }

  // ========== CORE COMMANDS ==========
  console.log('\n=== Core Commands ===');

  await test('help', async () => {
    const r = await orbit.run({ cmd: 'help' });
    if (!r.ok) throw new Error('help failed');
    return `${r.data.commands?.length || 'many'} commands listed`;
  });

  await test('help widgets.find', async () => {
    const r = await orbit.run({ cmd: 'help', args: { cmd: 'widgets.find' } });
    if (!r.ok) throw new Error('help cmd failed');
    return 'Detailed help ok';
  });

  await test('api.capabilities', async () => {
    const r = await orbit.run({ cmd: 'api.capabilities' });
    if (!r.ok) throw new Error('capabilities failed');
    return r.data.adapter;
  });

  // ========== POLICY ==========
  console.log('\n=== Policy (Beast Mode) ===');

  await test('policy: beast mode defaults', async () => {
    const policy = pe.getPolicy();
    const errors = [];
    if (policy.safeMode !== 'fullWrite') errors.push(`safeMode=${policy.safeMode} (expected fullWrite)`);
    if (policy.denyFileKeyPrefixes.length !== 0) errors.push(`denyPrefixes=${JSON.stringify(policy.denyFileKeyPrefixes)} (expected [])`);
    if (policy.maxFilesPerApply !== 500) errors.push(`maxFiles=${policy.maxFilesPerApply} (expected 500)`);
    if (policy.allowPlatformConfigEdits !== true) errors.push(`platformConfig=${policy.allowPlatformConfigEdits} (expected true)`);
    if (policy.requireManualApproval !== false) errors.push(`requireManualApproval=${policy.requireManualApproval} (expected false)`);
    if (errors.length > 0) throw new Error(errors.join('; '));
    return `safeMode=fullWrite, denyPrefixes=[], maxFiles=500, platformConfig=true`;
  });

  // ========== SCHEMA ==========
  console.log('\n=== Schema Docs ===');

  await test('schema.search: navigation', async () => {
    const r = await orbit.run({ cmd: 'schema.search', args: { q: 'navigation' } });
    if (!r.ok) throw new Error(JSON.stringify(r));
    return `${r.data.results?.length || 0} results`;
  });

  await test('schema.search: form validation', async () => {
    const r = await orbit.run({ cmd: 'schema.search', args: { q: 'form validation' } });
    return `${r.data?.results?.length || 0} results`;
  });

  // ========== INTENT ==========
  console.log('\n=== Intent (NL → Command) ===');

  await test('intent.run: list pages', async () => {
    const r = await orbit.run({ cmd: 'intent.run', args: { text: 'list pages' } });
    return r.data?.mappedCommand || 'mapped';
  });

  await test('intent.run: find buttons', async () => {
    const r = await orbit.run({ cmd: 'intent.run', args: { text: 'find buttons on login' } });
    return r.data?.mappedCommand || 'mapped';
  });

  await test('intent.run: create page', async () => {
    const r = await orbit.run({ cmd: 'intent.run', args: { text: 'create a settings page' } });
    return r.data?.mappedCommand || JSON.stringify(r.data || r).substring(0, 100);
  });

  // ========== SNAPSHOT-DEPENDENT (uses existing cache) ==========
  const snaps = sr.listSnapshots();
  if (snaps.length > 0) {
    const snapId = snaps[0].id;
    const fileCount = sr.countFiles(snaps[0].snapshotId);
    console.log(`\n=== Snapshot Tests (using ${snaps[0].snapshotId}, ${fileCount} files) ===`);

    await test('pages.list', async () => {
      const r = await orbit.run({ cmd: 'pages.list', args: { projectId: PROJECT_ID } });
      if (!r.ok) throw new Error(JSON.stringify(r));
      const pages = r.data?.pages || [];
      return `${pages.length} pages: ${pages.slice(0, 5).map(p => p.name).join(', ')}...`;
    });

    await test('search: Consultation', async () => {
      const r = await orbit.run({ cmd: 'search', args: { q: 'Consultation' } });
      return `${r.data?.results?.length || r.data?.totalMatches || 0} matches`;
    });

    await test('search: Button', async () => {
      const r = await orbit.run({ cmd: 'search', args: { q: 'Button' } });
      return `${r.data?.results?.length || r.data?.totalMatches || 0} matches`;
    });

    await test('graph.nav', async () => {
      const r = await orbit.run({ cmd: 'graph.nav', args: { projectId: PROJECT_ID } });
      const edges = r.data?.edges?.length || r.data?.navigationEdges?.length || 0;
      return `${edges} navigation edges`;
    });

    await test('graph.usage', async () => {
      const r = await orbit.run({ cmd: 'graph.usage', args: { projectId: PROJECT_ID } });
      return `${r.data?.edges?.length || r.data?.usageEdges?.length || 0} usage edges`;
    });

    await test('summarize.project', async () => {
      const r = await orbit.run({ cmd: 'summarize.project', args: { projectId: PROJECT_ID } });
      const counts = r.data?.counts || {};
      return `files: ${counts.files}, pages: ${counts.pages}, components: ${counts.components}`;
    });

    // Test batch SQLite reads (getFiles)
    await test('batch getFiles performance', async () => {
      const start = Date.now();
      const files = sr.listFiles(snaps[0].snapshotId, 'page/', 100);
      const keys = files.slice(0, 20).map(f => f.fileKey);
      const batch = sr.getFiles(snaps[0].snapshotId, keys);
      const ms = Date.now() - start;
      return `${batch.size}/${keys.length} files in ${ms}ms (batch read)`;
    });

    // Test changeset flow (dry run — no apply, only if snapshot has files)
    if (fileCount > 0) {
      await test('changeset.new + add + preview + drop', async () => {
        const chg = cs.newChangeset(snaps[0].snapshotId, 'E2E test', 'Verify changeset pipeline');
        cs.addEntry(chg.changesetId, 'app-details', {
          type: 'yaml-merge',
          selector: '$.appName',
          value: 'MedzenHealth Pro Test'
        });
        const preview = cs.preview(chg.changesetId);
        cs.dropChangeset(chg.changesetId);
        return `risk=${preview.riskScore}, files=${preview.files.length}, lines=${preview.impact.linesChanged} (dropped, not applied)`;
      });
    } else {
      console.log('  [SKIP] changeset.new + add + preview + drop (snapshot has 0 files)');
    }

    // Test file cap (15k)
    await test('file cap: 15k limit works', async () => {
      const allFiles = sr.listFiles(snaps[0].snapshotId, undefined, 15000);
      return `${allFiles.length} files readable (cap=15k)`;
    });

  } else {
    console.log('\n=== SKIPPING snapshot tests (no snapshot in cache) ===');
    console.log('Run: orbit({ cmd: "snapshots.create", args: { projectId: "medzen-health-pro-0lbqv7" } }) first');
  }

  // ========== API CONNECTION (single lightweight call) ==========
  console.log('\n=== API Connection ===');

  await test('adapter.listPartitionedFileNames', async () => {
    const result = await adapter.listPartitionedFileNames(PROJECT_ID);
    return `${result.files.length} remote files, version: ${result.versionInfo?.partitionerVersion || 'unknown'}`;
  });

  // ========== SUMMARY ==========
  console.log(`\n========================================`);
  console.log(`TOTAL: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);

  // Performance summary
  const sorted = times.sort((a, b) => b.ms - a.ms);
  console.log('\nSlowest tests:');
  for (const t of sorted.slice(0, 5)) {
    console.log(`  ${t.ms}ms — ${t.name}`);
  }

  db.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL:', e.message, e.stack?.substring(0, 300));
  process.exit(1);
});
