import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import pLimit from "p-limit";

const SCHOOLS_FILE_DEFAULT = "schools.txt";
const OUTPUT_SCHOOLS_DIR = path.join("output", "schools");

// CLI argument types
interface RunnerConfig {
  step: "all" | "scrape" | "merge" | "collapse-ab" | "gpa" | "prerequisites";
  concurrency: number | null; // null = unlimited
  clean: boolean;
  schoolsFile: string;
}

/**
 * Parse CLI arguments
 */
function parseArgs(): RunnerConfig {
  const args = process.argv.slice(2);
  const config: RunnerConfig = {
    step: "all",
    concurrency: null,
    clean: false,
    schoolsFile: SCHOOLS_FILE_DEFAULT,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--step":
        const step = args[i + 1];
        if (!["all", "scrape", "merge", "collapse-ab", "gpa", "prerequisites"].includes(step)) {
          throw new Error(
            `Invalid step: ${step}. Must be one of: all, scrape, merge, collapse-ab, gpa, prerequisites`
          );
        }
        config.step = step as RunnerConfig["step"];
        i++;
        break;
      case "--concurrency":
        config.concurrency = parseInt(args[i + 1]);
        if (isNaN(config.concurrency) || config.concurrency < 1) {
          throw new Error("--concurrency must be a positive integer");
        }
        i++;
        break;
      case "--clean":
        config.clean = true;
        break;
      case "--schools-file":
        config.schoolsFile = args[i + 1];
        i++;
        break;
      default:
        if (arg.startsWith("--")) {
          console.warn(`Unknown argument: ${arg}`);
        }
    }
  }

  return config;
}

/**
 * Read and parse schools from the schools file
 */
async function readSchoolsFromFile(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const schools: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines, comments, and header lines
      if (
        !trimmed ||
        trimmed.startsWith("#") ||
        trimmed.startsWith("Available schools:") ||
        trimmed === "-"
      ) {
        continue;
      }
      // Extract school name (remove leading dash and spaces)
      const schoolMatch = trimmed.match(/^-?\s*(.+)$/);
      if (schoolMatch) {
        schools.push(schoolMatch[1].trim());
      }
    }

    return schools;
  } catch (error) {
    throw new Error(
      `Failed to read schools file at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Clean the output/schools directory
 */
async function cleanOutputDirectory(): Promise<void> {
  console.log(`\nCleaning ${OUTPUT_SCHOOLS_DIR}...`);
  try {
    const entries = await fs.readdir(OUTPUT_SCHOOLS_DIR);
    for (const entry of entries) {
      const fullPath = path.join(OUTPUT_SCHOOLS_DIR, entry);
      await fs.unlink(fullPath);
    }
    console.log(`✓ Cleaned ${entries.length} file(s)`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("Directory doesn't exist yet, nothing to clean");
    } else {
      throw error;
    }
  }
}

/**
 * Run a child process and return a promise that resolves with exit code
 */
function runProcess(
  command: string,
  args: string[],
  schoolName?: string
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    // #region agent log
    fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'run.ts:132',message:'Spawning child process',data:{command,args,schoolName},timestamp:Date.now(),runId:'post-fix',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    const proc = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let output = "";
    let errorOutput = "";

    if (proc.stdout) {
      proc.stdout.on("data", (data) => {
        const text = data.toString();
        output += text;
        if (schoolName) {
          // Prefix output with school name for parallel execution
          process.stdout.write(`[${schoolName}] ${text}`);
        } else {
          process.stdout.write(text);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.on("data", (data) => {
        const text = data.toString();
        errorOutput += text;
        if (schoolName) {
          process.stderr.write(`[${schoolName}] ${text}`);
        } else {
          process.stderr.write(text);
        }
      });
    }

    proc.on("close", (code) => {
      resolve({
        exitCode: code || 0,
        output: output + errorOutput,
      });
    });

    proc.on("error", (error) => {
      console.error(
        `Process error${schoolName ? ` for ${schoolName}` : ""}: ${error.message}`
      );
      resolve({
        exitCode: 1,
        output: output + errorOutput + `\nProcess error: ${error.message}`,
      });
    });
  });
}

/**
 * Run scrapers for all schools in parallel (with optional concurrency limit)
 */
async function runScrapers(
  schools: string[],
  concurrency: number | null
): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 1: PARALLEL SCRAPING");
  console.log("=".repeat(60));
  console.log(`\nScraping ${schools.length} schools...`);
  if (concurrency) {
    console.log(`Concurrency limit: ${concurrency}`);
  } else {
    console.log("Concurrency: unlimited (all schools in parallel)");
  }
  console.log("");

  const startTime = Date.now();
  const limit = concurrency ? pLimit(concurrency) : pLimit(Infinity);

  // Track running processes for cleanup
  const runningProcesses: ChildProcess[] = [];
  let shouldAbort = false;

  const tasks = schools.map((school) =>
    limit(async () => {
      if (shouldAbort) {
        return { school, success: false, error: "Aborted due to other failure" };
      }

      console.log(`[${school}] Starting scraper...`);
      const result = await runProcess(
        "node",
        ["-r", "ts-node/register", "src/scrape.ts", "--school", school],
        school
      );

      if (result.exitCode !== 0) {
        shouldAbort = true;
        return {
          school,
          success: false,
          error: `Exit code ${result.exitCode}`,
          output: result.output,
        };
      }

      return { school, success: true };
    })
  );

  const results = await Promise.all(tasks);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Check for failures
  const failures = results.filter((r) => !r.success);

  if (failures.length > 0) {
    console.error("\n\n" + "=".repeat(60));
    console.error("SCRAPING FAILED");
    console.error("=".repeat(60));
    console.error(`\n${failures.length} school(s) failed:\n`);

    for (const failure of failures) {
      console.error(`✗ ${failure.school}`);
      if (failure.error) {
        console.error(`  Error: ${failure.error}`);
      }
      if (failure.output) {
        console.error(`  Last output:\n${failure.output.slice(-500)}`);
      }
    }

    throw new Error(`Scraping failed for ${failures.length} school(s)`);
  }

  console.log("\n\n" + "=".repeat(60));
  console.log("SCRAPING COMPLETE");
  console.log("=".repeat(60));
  console.log(`✓ Successfully scraped ${schools.length} schools in ${elapsed}s`);
}

/**
 * Run the merge migration (schools -> district)
 */
async function runMergeMigration(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 2: MERGE SCHOOLS TO DISTRICT");
  console.log("=".repeat(60) + "\n");

  // Check if school files exist
  try {
    const entries = await fs.readdir(OUTPUT_SCHOOLS_DIR);
    const jsonFiles = entries.filter((f) =>
      f.toLowerCase().endsWith(".json")
    );
    if (jsonFiles.length === 0) {
      throw new Error(
        `No school JSON files found in ${OUTPUT_SCHOOLS_DIR}. Run scraping first.`
      );
    }
    console.log(`Found ${jsonFiles.length} school file(s) to merge\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Directory ${OUTPUT_SCHOOLS_DIR} not found. Run scraping first.`
      );
    }
    throw error;
  }

  const result = await runProcess("node", [
    "-r",
    "ts-node/register",
    "src/migrations/migrate-schools-to-district.ts",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`Merge migration failed with exit code ${result.exitCode}`);
  }

  console.log("\n✓ Merge completed successfully");
}

/**
 * Run the A/B course collapse migration
 */
async function runCollapseABMigration(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 3: COLLAPSE A/B COURSES");
  console.log("=".repeat(60) + "\n");

  // Check if merged file exists
  const mergedFile = path.join("output", "courses.katy-isd.json");
  try {
    await fs.access(mergedFile);
  } catch (error) {
    throw new Error(
      `Merged file ${mergedFile} not found. Run merge step first.`
    );
  }

  const result = await runProcess("node", [
    "-r",
    "ts-node/register",
    "src/migrations/migrate-collapse-ab-courses.ts",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `A/B collapse migration failed with exit code ${result.exitCode}`
    );
  }

  console.log("\n✓ A/B courses collapsed successfully");
}

/**
 * Run the GPA migration
 */
async function runGPAMigration(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 4: MIGRATE GPA");
  console.log("=".repeat(60) + "\n");

  // Check if merged file exists
  const mergedFile = path.join("output", "courses.katy-isd.json");
  try {
    await fs.access(mergedFile);
  } catch (error) {
    throw new Error(
      `Merged file ${mergedFile} not found. Run merge step first.`
    );
  }

  const result = await runProcess("node", [
    "-r",
    "ts-node/register",
    "src/migrations/migrate-gpa.ts",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `GPA migration failed with exit code ${result.exitCode}`
    );
  }

  console.log("\n✓ GPA migration completed successfully");
}

/**
 * Run the prerequisites migration
 */
async function runPrerequisitesMigration(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 5: FIX PREREQUISITES");
  console.log("=".repeat(60) + "\n");

  // Check if merged file exists
  const mergedFile = path.join("output", "courses.katy-isd.json");
  try {
    await fs.access(mergedFile);
  } catch (error) {
    throw new Error(
      `Merged file ${mergedFile} not found. Run merge step first.`
    );
  }

  const result = await runProcess("node", [
    "-r",
    "ts-node/register",
    "src/migrations/migrate-prerequisites.ts",
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `Prerequisites migration failed with exit code ${result.exitCode}`
    );
  }

  console.log("\n✓ Prerequisites fixed successfully");
}

/**
 * Main runner function
 */
async function main(): Promise<void> {
  console.log("SchooLinks Course Catalog - Parallel Scraper Runner");
  console.log("===================================================\n");

  try {
    const config = parseArgs();

    console.log("Configuration:");
    console.log(`  Step: ${config.step}`);
    console.log(`  Concurrency: ${config.concurrency || "unlimited"}`);
    console.log(`  Clean: ${config.clean}`);
    console.log(`  Schools file: ${config.schoolsFile}`);

    // Read schools if we're running the scrape step
    let schools: string[] = [];
    if (config.step === "all" || config.step === "scrape") {
      schools = await readSchoolsFromFile(config.schoolsFile);
      console.log(`\nFound ${schools.length} schools to scrape`);

      if (config.clean) {
        await cleanOutputDirectory();
      }
    }

    // Execute requested steps
    const startTime = Date.now();

    if (config.step === "all") {
      // Run all steps in sequence
      await runScrapers(schools, config.concurrency);
      await runMergeMigration();
      await runCollapseABMigration();
      await runGPAMigration();
      await runPrerequisitesMigration();
    } else if (config.step === "scrape") {
      await runScrapers(schools, config.concurrency);
    } else if (config.step === "merge") {
      await runMergeMigration();
    } else if (config.step === "collapse-ab") {
      await runCollapseABMigration();
    } else if (config.step === "gpa") {
      await runGPAMigration();
    } else if (config.step === "prerequisites") {
      await runPrerequisitesMigration();
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n\n" + "=".repeat(60));
    console.log("ALL STEPS COMPLETED SUCCESSFULLY");
    console.log("=".repeat(60));
    console.log(`\nTotal execution time: ${totalElapsed}s`);
    console.log("\nOutput files:");
    console.log(`  - output/schools/*.json (per-school data)`);
    console.log(`  - output/courses.katy-isd.json (merged district data)`);
  } catch (error) {
    console.error("\n\n" + "=".repeat(60));
    console.error("RUNNER FAILED");
    console.error("=".repeat(60));
    if (error instanceof Error) {
      console.error(`\nError: ${error.message}`);
      if (error.stack) {
        console.error(`\nStack trace:\n${error.stack}`);
      }
    } else {
      console.error(`\nError: ${String(error)}`);
    }
    process.exit(1);
  }
}

// Run the runner
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

