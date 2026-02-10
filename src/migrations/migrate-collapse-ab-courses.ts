import { promises as fs } from "fs";
import * as path from "path";
import { CourseCatalogSchema, Course } from "../schema";

const OUTPUT_FILE = path.join("output", "courses.katy-isd.json");

/**
 * Normalizes a school name for comparison (removes spaces, converts to lowercase)
 */
function normalizeSchoolName(name: string): string {
  return name.replace(/\s+/g, "").toLowerCase();
}

/**
 * Merges two arrays of strings with deduplication
 */
function mergeArrays(arr1: string[], arr2: string[]): string[] {
  const result = [...arr1];
  for (const item of arr2) {
    if (!result.includes(item)) {
      result.push(item);
    }
  }
  return result;
}

/**
 * Merges two school arrays with normalized comparison to avoid duplicates
 */
function mergeSchools(schools1: string[], schools2: string[]): string[] {
  const result = [...schools1];
  for (const school of schools2) {
    const normalizedSchool = normalizeSchoolName(school);
    // Check if this school already exists (normalized comparison)
    const exists = result.some(s => normalizeSchoolName(s) === normalizedSchool);
    if (!exists) {
      result.push(school);
    }
  }
  return result;
}

/**
 * Checks if a value is effectively empty
 */
function isEmpty(value: string | undefined | null): boolean {
  return !value || value.trim() === "" || value.toLowerCase() === "n/a";
}

/**
 * Returns the first non-empty value, or "n/a" if both are empty
 */
function coalesce(value1: string, value2: string): string {
  return isEmpty(value1) ? value2 : value1;
}

/**
 * Removes trailing " A" or " B" from a course name
 * Handles cases like:
 * - "Art 1 A (High School Credit)" → "Art 1 (High School Credit)"
 * - "Academic Decathlon 2A" → "Academic Decathlon 2"
 * - "Peer Assistance and Leadership 1A" → "Peer Assistance and Leadership 1"
 */
function stripABSuffix(courseName: string): string {
  // Match trailing A or B that is:
  // 1. Preceded by a space (remove space + A/B)
  // 2. OR directly after a digit/letter (remove just A/B, keep the preceding character)
  // Optionally followed by whitespace and parenthetical content
  // Pattern: (space + A/B) OR (digit/letter + A/B), optionally followed by space and parentheses
  return courseName
    .replace(/\s+[AB](\s*\(.*\))?$/i, '$1') // Remove " A" or " B" with space before
    .replace(/([0-9A-Za-z])[AB](\s*\(.*\))?$/i, '$1$2') // Remove A/B after digit/letter
    .trim();
}

/**
 * Consolidates an A and B course into a single full-year course
 */
function consolidatePair(courseA: Course, courseB: Course, baseCode: string): Course {
  // Start with A course as base, then merge/override specific fields
  const consolidated: Course = {
    courseCode: baseCode, // Strip the A/B suffix
    courseName: stripABSuffix(courseA.courseName),
    credits: courseA.credits + courseB.credits, // Sum credits
    term: "Semester 1-Semester 2", // Full year term
    gpa: courseA.gpa, // Prefer A's GPA
    
    // Scalar fields: prefer A, fallback to B if A is empty
    subject: coalesce(courseA.subject, courseB.subject),
    prerequisite: coalesce(courseA.prerequisite, courseB.prerequisite),
    corequisite: coalesce(courseA.corequisite, courseB.corequisite),
    enrollmentNotes: coalesce(courseA.enrollmentNotes, courseB.enrollmentNotes),
    courseDescription: coalesce(courseA.courseDescription, courseB.courseDescription),
    
    // Array fields: union with deduplication
    tags: mergeArrays(courseA.tags, courseB.tags),
    schools: mergeSchools(courseA.schools, courseB.schools),
    eligibleGrades: mergeArrays(courseA.eligibleGrades, courseB.eligibleGrades),
  };
  
  return consolidated;
}

/**
 * Migration script to collapse A/B semester course pairs into single full-year courses
 */
async function main(): Promise<void> {
  console.log("Collapse A/B Courses Migration Script");
  console.log("======================================\n");

  try {
    // Read existing JSON file
    console.log(`Reading ${OUTPUT_FILE}...`);
    const data = await fs.readFile(OUTPUT_FILE, "utf-8");
    const catalog = JSON.parse(data);

    // Validate input structure
    if (!catalog.courses || !Array.isArray(catalog.courses)) {
      throw new Error("Invalid catalog structure: courses array not found");
    }

    console.log(`Found ${catalog.courses.length} courses\n`);
    
    // Validate input catalog
    console.log("Validating input catalog...");
    CourseCatalogSchema.parse(catalog);
    console.log("✓ Input validation passed\n");

    // Group courses by base code (courseCode without trailing A or B)
    console.log("Grouping courses by base code...");
    const groups = new Map<string, { A?: Course; B?: Course; other: Course[] }>();
    
    for (const course of catalog.courses) {
      const code = course.courseCode;
      const match = code.match(/^(.+)([AB])$/);
      
      if (match) {
        // Course code ends with A or B
        const baseCode = match[1];
        const suffix = match[2];
        
        if (!groups.has(baseCode)) {
          groups.set(baseCode, { other: [] });
        }
        
        const group = groups.get(baseCode)!;
        if (suffix === 'A') {
          if (group.A) {
            console.warn(`Warning: Multiple A courses found for base code ${baseCode}`);
            // Treat duplicates as separate courses
            group.other.push(course);
          } else {
            group.A = course;
          }
        } else {
          if (group.B) {
            console.warn(`Warning: Multiple B courses found for base code ${baseCode}`);
            // Treat duplicates as separate courses
            group.other.push(course);
          } else {
            group.B = course;
          }
        }
      } else {
        // Course code doesn't end with A or B - keep as-is
        const fakeBase = `__no_suffix_${code}`;
        groups.set(fakeBase, { other: [course] });
      }
    }

    console.log(`Grouped into ${groups.size} base code groups\n`);

    // Build new course list
    console.log("Building consolidated course list...");
    const newCourses: Course[] = [];
    let collapsedPairs = 0;
    let partialPairs = 0;
    let untouchedCourses = 0;

    for (const [baseCode, group] of groups.entries()) {
      if (baseCode.startsWith('__no_suffix_')) {
        // Non-A/B courses - but still check and strip any trailing A/B from names
        const cleanedOther = group.other.map(course => ({
          ...course,
          courseName: stripABSuffix(course.courseName)
        }));
        newCourses.push(...cleanedOther);
        untouchedCourses += cleanedOther.length;
      } else if (group.A && group.B) {
        // Full A/B pair - consolidate
        const consolidated = consolidatePair(group.A, group.B, baseCode);
        newCourses.push(consolidated);
        collapsedPairs++;
        
        // Also include any "other" courses (duplicates beyond the first A and B)
        // Strip A/B from their names too
        if (group.other.length > 0) {
          const cleanedOther = group.other.map(course => ({
            ...course,
            courseName: stripABSuffix(course.courseName)
          }));
          newCourses.push(...cleanedOther);
          untouchedCourses += cleanedOther.length;
        }
      } else {
        // Partial pair (only A or only B) - strip A/B suffix from name but keep course
        if (group.A) {
          const course = { ...group.A };
          course.courseName = stripABSuffix(course.courseName);
          newCourses.push(course);
          partialPairs++;
        }
        if (group.B) {
          const course = { ...group.B };
          course.courseName = stripABSuffix(course.courseName);
          newCourses.push(course);
          partialPairs++;
        }
        if (group.other.length > 0) {
          // Also strip A/B from any other courses
          const cleanedOther = group.other.map(course => ({
            ...course,
            courseName: stripABSuffix(course.courseName)
          }));
          newCourses.push(...cleanedOther);
          untouchedCourses += cleanedOther.length;
        }
      }
    }

    console.log(`\nConsolidation summary:`);
    console.log(`  A/B pairs collapsed: ${collapsedPairs}`);
    console.log(`  Partial pairs (kept as-is): ${partialPairs}`);
    console.log(`  Other courses (untouched): ${untouchedCourses}`);
    console.log(`  Total courses before: ${catalog.courses.length}`);
    console.log(`  Total courses after: ${newCourses.length}`);
    console.log(`  Net reduction: ${catalog.courses.length - newCourses.length} courses`);

    // Update catalog with new course list
    catalog.courses = newCourses;

    // Validate the updated catalog against schema
    console.log("\nValidating updated catalog...");
    const validated = CourseCatalogSchema.parse(catalog);
    console.log("✓ Output validation passed");

    // Write updated data back to file
    console.log(`\nWriting updated data to ${OUTPUT_FILE}...`);
    await fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify(validated, null, 2),
      "utf-8"
    );

    console.log("\n✓ Migration completed successfully!");

  } catch (error) {
    console.error("\n✗ Migration failed");
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      if (error.stack) {
        console.error("Stack trace:", error.stack);
      }
      // If it's a Zod error, log validation issues
      if ((error as any).issues && Array.isArray((error as any).issues)) {
        console.error(`Validation errors: ${(error as any).issues.length} issue(s) found`);
        try {
          const issues = (error as any).issues.slice(0, 5); // Show first 5 issues
          for (const issue of issues) {
            console.error(`  - Path: ${issue.path.join('.')}, Message: ${issue.message}`);
          }
          if ((error as any).issues.length > 5) {
            console.error(`  ... and ${(error as any).issues.length - 5} more`);
          }
        } catch (e) {
          // Ignore if we can't extract issue details
        }
      }
    } else {
      try {
        console.error("Error details:", JSON.stringify(error, null, 2));
      } catch (e) {
        console.error("Error (could not serialize)");
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

