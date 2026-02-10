import { promises as fs } from "fs";
import * as path from "path";
import { Course, CourseCatalogSchema } from "../schema";

const DISTRICT = "katy-isd";
const TARGET_URL =
  "https://app.schoolinks.com/course-catalog/katy-isd/course-offerings";

const OUTPUT_DIR = "output";
const SCHOOLS_DIR = path.join(OUTPUT_DIR, "schools");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "courses.katy-isd.json");

/**
 * Normalizes a school name for comparison (removes spaces, converts to lowercase)
 * Example: "Adams Junior High" -> "adamsjuniorhigh"
 */
function normalizeSchoolName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

/**
 * Finds the canonical school name format from existing schools array
 * Prefers names with spaces (proper format) over slugified versions
 */
function findCanonicalSchoolName(
  normalizedTarget: string,
  existingSchools: string[]
): string | null {
  // First, try to find exact match (case-insensitive, space-insensitive)
  for (const school of existingSchools) {
    if (normalizeSchoolName(school) === normalizedTarget) {
      // Prefer the one with spaces (proper format)
      if (school.includes(" ")) {
        return school;
      }
    }
  }
  // If no match with spaces found, return any match
  for (const school of existingSchools) {
    if (normalizeSchoolName(school) === normalizedTarget) {
      return school;
    }
  }
  return null;
}

/**
 * Migration script that merges per-school course JSON files
 * from output/schools into a single district-wide catalog.
 */
async function main(): Promise<void> {
  console.log("Merge Schools → District Catalog Migration");
  console.log("=========================================\n");

  try {
    // Ensure schools directory exists
    let entries: string[];
    try {
      entries = await fs.readdir(SCHOOLS_DIR);
    } catch (error) {
      console.error(
        `ERROR: Could not read schools directory at ${SCHOOLS_DIR}.`
      );
      console.error(
        "Make sure you've run the scraper for individual schools first."
      );
      process.exit(1);
      return;
    }

    const jsonFiles = entries.filter(
      (name) =>
        name.toLowerCase().startsWith("courses.katyisd.") &&
        name.toLowerCase().endsWith(".json")
    );

    if (jsonFiles.length === 0) {
      console.error(
        `ERROR: No per-school course files found in ${SCHOOLS_DIR}.`
      );
      process.exit(1);
      return;
    }

    console.log(`Found ${jsonFiles.length} per-school JSON files to merge:\n`);
    jsonFiles.forEach((f) => console.log(`  - ${f}`));

    const coursesMap: Record<string, Course> = {};
    let totalCoursesSeen = 0;

    for (const fileName of jsonFiles) {
      const fullPath = path.join(SCHOOLS_DIR, fileName);
      console.log(`\nReading ${fullPath}...`);

      const data = await fs.readFile(fullPath, "utf-8");
      const parsed = JSON.parse(data);

      // We expect shape { source, courses: Course[] }
      if (!parsed.courses || !Array.isArray(parsed.courses)) {
        console.warn(
          `  Skipping ${fileName}: missing or invalid "courses" array`
        );
        continue;
      }

      let schoolName =
        parsed.source?.school ||
        fileName.replace(/^courses\.katyisd\./i, "").replace(/\.json$/i, "");
      
      // If schoolName came from filename (no spaces), try to find canonical format from courses
      const courses: Course[] = parsed.courses;
      if (!schoolName.includes(" ") && courses.length > 0) {
        // Look for canonical format in existing schools arrays
        const normalizedTarget = normalizeSchoolName(schoolName);
        for (const course of courses) {
          if (course.schools && Array.isArray(course.schools) && course.schools.length > 0) {
            const canonical = findCanonicalSchoolName(normalizedTarget, course.schools);
            if (canonical) {
              schoolName = canonical;
              break;
            }
          }
        }
      }
      
      // #region agent log
      fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'migrate-schools-to-district.ts:72',message:'Extracted schoolName from file',data:{fileName,sourceSchool:parsed.source?.school,schoolNameFinal:schoolName},timestamp:Date.now(),runId:'post-fix',hypothesisId:'A'})}).catch(()=>{});
      // #endregion

      console.log(
        `  Found ${courses.length} courses for school "${schoolName}"`
      );
      // #region agent log
      if (courses.length > 0) {
        const sampleCourse = courses[0];
        fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'migrate-schools-to-district.ts:78',message:'Sample course schools array before processing',data:{courseCode:sampleCourse.courseCode,schoolsBefore:sampleCourse.schools},timestamp:Date.now(),runId:'post-fix',hypothesisId:'B'})}).catch(()=>{});
      }
      // #endregion

      totalCoursesSeen += courses.length;

      for (const course of courses) {
        const code = course.courseCode;
        if (!code) {
          continue;
        }

        // Normalize schools array
        if (!course.schools || !Array.isArray(course.schools)) {
          course.schools = [];
        }
        // #region agent log
        const schoolsBeforeAdd = [...course.schools];
        const normalizedSchoolName = normalizeSchoolName(schoolName);
        const hasNormalizedMatch = course.schools.some(sch => normalizeSchoolName(sch) === normalizedSchoolName);
        const willAdd = schoolName && !hasNormalizedMatch;
        fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'migrate-schools-to-district.ts:93',message:'Before adding schoolName to course',data:{courseCode:code,schoolName,schoolsBefore:schoolsBeforeAdd,hasNormalizedMatch,willAdd},timestamp:Date.now(),runId:'post-fix',hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        // Use normalized comparison to avoid duplicates
        if (schoolName && !course.schools.some(sch => normalizeSchoolName(sch) === normalizedSchoolName)) {
          course.schools.push(schoolName);
        }
        // #region agent log
        fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'migrate-schools-to-district.ts:95',message:'After adding schoolName to course',data:{courseCode:code,schoolsAfter:[...course.schools]},timestamp:Date.now(),runId:'post-fix',hypothesisId:'B'})}).catch(()=>{});
        // #endregion

        if (coursesMap[code]) {
          const existing = coursesMap[code];
          // #region agent log
          fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'migrate-schools-to-district.ts:97',message:'Merging duplicate courseCode',data:{courseCode:code,existingSchools:[...existing.schools],newCourseSchools:[...course.schools]},timestamp:Date.now(),runId:'initial',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
          // Merge field-by-field where appropriate; for now, trust latest non-empty values
          if (!existing.courseName && course.courseName) {
            existing.courseName = course.courseName;
          }
          if (!existing.subject && course.subject) {
            existing.subject = course.subject;
          }
          if (!existing.term && course.term) {
            existing.term = course.term;
          }
          if (!existing.prerequisite && course.prerequisite) {
            existing.prerequisite = course.prerequisite;
          }
          if (!existing.corequisite && course.corequisite) {
            existing.corequisite = course.corequisite;
          }
          if (!existing.enrollmentNotes && course.enrollmentNotes) {
            existing.enrollmentNotes = course.enrollmentNotes;
          }
          if (!existing.courseDescription && course.courseDescription) {
            existing.courseDescription = course.courseDescription;
          }

          // Merge schools lists using normalized comparison
          for (const sch of course.schools) {
            const normalizedSch = normalizeSchoolName(sch);
            // Find existing match (if any) using normalized comparison
            const existingMatch = existing.schools.find(existingSch => 
              normalizeSchoolName(existingSch) === normalizedSch
            );
            // #region agent log
            fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'migrate-schools-to-district.ts:123',message:'Checking if school should be added to existing course',data:{courseCode:code,schoolToAdd:sch,normalizedSch,existingSchools:[...existing.schools],hasMatch:!!existingMatch},timestamp:Date.now(),runId:'post-fix',hypothesisId:'C'})}).catch(()=>{});
            // #endregion
            if (!existingMatch) {
              // No match found, add the school
              existing.schools.push(sch);
            } else if (sch.includes(" ") && !existingMatch.includes(" ")) {
              // Prefer the format with spaces - replace slugified version with proper format
              const index = existing.schools.indexOf(existingMatch);
              existing.schools[index] = sch;
            }
            // If match exists and new format doesn't have spaces, keep the existing one
          }
          // #region agent log
          fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'migrate-schools-to-district.ts:127',message:'After merging schools for duplicate courseCode',data:{courseCode:code,finalSchools:[...existing.schools]},timestamp:Date.now(),runId:'post-fix',hypothesisId:'C'})}).catch(()=>{});
          // #endregion
        } else {
          coursesMap[code] = course;
        }
      }
    }

    const mergedCourses = Object.values(coursesMap);

    console.log("\n\nMerge complete.");
    console.log(`  Raw course rows read: ${totalCoursesSeen}`);
    console.log(`  Unique courses by code: ${mergedCourses.length}`);

    if (mergedCourses.length === 0) {
      console.error(
        "\nERROR: No courses ended up in the merged map. Aborting without writing output."
      );
      process.exit(1);
      return;
    }

    const catalog = {
      source: {
        district: DISTRICT,
        url: TARGET_URL,
      },
      courses: mergedCourses,
    };

    console.log("\nValidating merged catalog against schema...");
    const validated = CourseCatalogSchema.parse(catalog);
    console.log("✓ Validation passed.");

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    console.log(`\nWriting merged district catalog to ${OUTPUT_FILE}...`);
    await fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify(validated, null, 2),
      "utf-8"
    );

    console.log("\n✓ Migration completed successfully!");
    console.log(`  Output file: ${OUTPUT_FILE}`);
    console.log(`  Total unique courses: ${validated.courses.length}`);
  } catch (error) {
    console.error("\n✗ Migration failed");
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      if (error.stack) {
        console.error(error.stack);
      }
    }
    process.exit(1);
  }
}

// Run the migration
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});


