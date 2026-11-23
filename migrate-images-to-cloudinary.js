// MyShopSwift — one-off migration: PostgreSQL images -> Cloudinary
//
//   node migrate-images-to-cloudinary.js --dry-run
//   node migrate-images-to-cloudinary.js --backup=./image-backup
//   node migrate-images-to-cloudinary.js
//   node migrate-images-to-cloudinary.js --apply-references
//
// Needs DATABASE_URL and CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
// CLOUDINARY_API_SECRET (from .env or the environment, same as server.js).
//
// What it does NOT do, ever: delete, truncate or empty anything. The old
// product_images rows and flyers.image_data bytes stay exactly as they are.
//
// Steps (run them in this order — see README):
//   --dry-run            reads only; prints what would be migrated. No writes at all.
//   --backup=DIR         writes every original image + a SHA-256 manifest to DIR (local copy).
//   (no flag)            uploads each old image to Cloudinary, verifies the URL loads and
//                        records the result in image_migrations. Changes nothing the shop
//                        displays. Safe to re-run: failed images are retried, finished
//                        ones are skipped, nothing is uploaded twice.
//   --apply-references   after the above: points products, categories and flyers at the
//                        new URLs — but only for images that migrated AND verified.
//   --limit=N            only attempt N images this run (try a small batch first).
//   --only=product|flyer restrict to one kind.

require("dotenv").config();
const { Pool } = require("pg");
const createMigrator = require("./image-migration");

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

async function main() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set."); process.exit(2); }
  const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const migrator = createMigrator({ db });

  const only = value("only");
  const kinds = only === "product" || only === "flyer" ? [only] : ["product", "flyer"];
  const limit = value("limit") ? Math.max(1, parseInt(value("limit"), 10) || 1) : Infinity;

  try {
    if (value("backup")) {
      const b = await migrator.backup(value("backup"), { kinds });
      console.log(`Backup written to ${b.dir}: ${b.files} image file(s) + manifest.json` + (b.problems ? ` (${b.problems} problem(s), see manifest)` : ""));
      if (!flag("dry-run") && args.length === 1) { await db.end(); return; } // --backup alone only backs up
    }

    const summary = await migrator.run({
      dryRun: flag("dry-run"), applyRefs: flag("apply-references"), limit, kinds,
      onProgress: ({ item, result, done }) =>
        console.log(`  [${done}] ${item.kind} ${item.id}: ${result.ok ? (result.existing ? "already in Cloudinary, verified" : "migrated + verified") : "FAILED — " + result.error}`)
    });

    console.log("\n=== Image migration summary ===");
    console.log(`Old images found:           ${summary.totalLegacy}`);
    console.log(`Already migrated (earlier): ${summary.alreadyMigrated}`);
    console.log(`Migrated this run:          ${summary.migratedNow}${summary.reusedExistingAsset ? ` (${summary.reusedExistingAsset} reused an asset already in Cloudinary)` : ""}`);
    console.log(`Failed:                     ${summary.failed}`);
    console.log(`Not attempted:              ${summary.notAttempted}${summary.dryRun ? " (dry run)" : ""}`);
    if (summary.warnings.length) console.log(`Warnings:                   ${summary.warnings.length} (see image_migrations.last_error)`);
    if (summary.referencesUpdated) console.log(`References updated:         products=${summary.referencesUpdated.products}, categories=${summary.referencesUpdated.categories}, flyers=${summary.referencesUpdated.flyers}`);
    if (summary.referencesStillOldStyle) console.log(`Products/categories still using old /uploads/ URLs: ${summary.referencesStillOldStyle.products}/${summary.referencesStillOldStyle.categories}`);
    if (summary.failures.length) { console.log("\nFailures (re-run the script to retry):"); summary.failures.forEach(f => console.log(`  - ${f.kind} ${f.id}: ${f.error}`)); }
    if (summary.dryRun) console.log("\nDry run only: nothing was uploaded or changed.");
    else if (!flag("apply-references") && summary.failed === 0) console.log("\nUploads verified. The shop is unchanged; when you're happy, run again with --apply-references.");

    await db.end();
    process.exit(summary.failed > 0 ? 1 : 0);
  } catch (error) {
    console.error("Migration stopped:", error.message);
    try { await db.end(); } catch (e) { /* ignore */ }
    process.exit(2);
  }
}
main();
