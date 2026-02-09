import { promises as fs } from "fs";
import * as path from "path";
import { CourseCatalogSchema, Course } from "../schema";

const OUTPUT_FILE = path.join("output", "courses.katy-isd.json");

/**
 * Migration script to convert prerequisites from course names to course codes
 */
async function main(): Promise<void> {
  console.log("Prerequisites Migration Script");
  console.log("==============================\n");

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

    // Build mapping from courseName to courseCode
    // Courses with the same name but different semester codes (A/B) are the same course
    // We'll use the first code found (typically the A semester) for matching
    const nameToCodeMap = new Map<string, string>();

    console.log("Building course name to code mapping...");
    for (const course of catalog.courses) {
      const courseName = course.courseName?.trim();
      const courseCode = course.courseCode?.trim();

      if (!courseName || !courseCode) {
        continue;
      }

      // If course name already exists, keep the first one (A semester typically comes first)
      // This is expected behavior - same course in different semesters (A/B)
      if (!nameToCodeMap.has(courseName)) {
        nameToCodeMap.set(courseName, courseCode);
      }
    }

    console.log(`\nBuilt mapping for ${nameToCodeMap.size} unique course names\n`);

    /**
     * Fixes common typos in course names
     */
    function fixTypos(name: string): string {
      let fixed = name;
      // Common typos
      fixed = fixed.replace(/caclulus/gi, 'calculus');
      fixed = fixed.replace(/amination/gi, 'animation');
      return fixed;
    }

    /**
     * Normalizes a course name for matching by:
     * - Converting Roman numerals to Arabic (I -> 1, II -> 2, III -> 3, IV -> 4)
     * - Removing special characters and suffixes
     * - Normalizing whitespace
     */
    function normalizeForMatching(name: string): string {
      let normalized = name.trim();
      
      // Fix typos first
      normalized = fixTypos(normalized);
      
      // Convert Roman numerals to Arabic (only standalone, not in words)
      normalized = normalized.replace(/\bI\b/g, '1');
      normalized = normalized.replace(/\bII\b/g, '2');
      normalized = normalized.replace(/\bIII\b/g, '3');
      normalized = normalized.replace(/\bIV\b/g, '4');
      
      // Remove common suffixes and special characters
      normalized = normalized.replace(/\s*\(KAP\)/gi, ' KAP'); // Keep KAP as part of name
      normalized = normalized.replace(/\s*\(.*?\)/g, ''); // Remove other parenthetical content
      normalized = normalized.replace(/^\*/, ''); // Remove leading asterisk
      normalized = normalized.replace(/\s*-\s*(VirSup|VirInstDay|SummerVir).*$/i, ''); // Remove virtual suffixes
      // Remove trailing single letter (A, B) but only if preceded by space and at end
      normalized = normalized.replace(/\s+[AB]\s*$/i, '');
      normalized = normalized.replace(/\s*&\s*/g, ' and '); // Normalize & to and
      normalized = normalized.replace(/\s+/g, ' ').trim(); // Normalize whitespace
      
      return normalized.toLowerCase();
    }

    // Build set of all course codes for validation
    const allCourseCodes = new Set<string>();
    for (const course of catalog.courses) {
      const courseCode = course.courseCode?.trim();
      if (courseCode) {
        allCourseCodes.add(courseCode);
      }
    }

    /**
     * Checks if a string is already a valid course code
     */
    function isCourseCode(code: string): boolean {
      // Check if it matches any existing course code in the catalog
      return allCourseCodes.has(code);
    }

    /**
     * Finds course code for a given prerequisite string
     * Handles exact matches, partial matches, Roman numerals, embedded patterns, etc.
     */
    function findCourseCode(prerequisite: string): string | null {
      if (!prerequisite || prerequisite.trim() === "" || prerequisite.toLowerCase() === "n/a") {
        return null;
      }

      let trimmed = prerequisite.trim();
      
      // Clean up data quality issues
      if (trimmed.toLowerCase().startsWith('corequisite:')) {
        trimmed = trimmed.replace(/^corequisite:\s*/i, '').trim();
        if (trimmed.toLowerCase() === 'n/a' || trimmed === '') {
          return null;
        }
      }
      
      // Handle standalone numbers (like "3" or "II") - these are probably not course codes
      if (/^\d+$/.test(trimmed) || /^[IVX]+$/i.test(trimmed)) {
        return null; // Skip standalone numbers
      }
      
      // Check if it's already a course code (skip conversion)
      if (isCourseCode(trimmed)) {
        return trimmed;
      }
      
      // Fix typos before matching
      trimmed = fixTypos(trimmed);
      
      const normalizedPrereq = normalizeForMatching(trimmed);

      // Try exact match first
      if (nameToCodeMap.has(trimmed)) {
        return nameToCodeMap.get(trimmed)!;
      }

      // Try case-insensitive exact match
      const lowerTrimmed = trimmed.toLowerCase();
      for (const [courseName, courseCode] of nameToCodeMap.entries()) {
        if (courseName.toLowerCase() === lowerTrimmed) {
          return courseCode;
        }
      }

      // Try normalized matching (handles Roman numerals, suffixes, etc.)
      for (const [courseName, courseCode] of nameToCodeMap.entries()) {
        const normalizedName = normalizeForMatching(courseName);
        if (normalizedName === normalizedPrereq) {
          return courseCode;
        }
      }

      // Try partial normalized match (e.g., "Algebra 1" matches "Algebra 1 A")
      for (const [courseName, courseCode] of nameToCodeMap.entries()) {
        const normalizedName = normalizeForMatching(courseName);
        if (normalizedName.startsWith(normalizedPrereq) || normalizedPrereq.startsWith(normalizedName)) {
          return courseCode;
        }
      }

      // Handle abbreviations and common variations (e.g., "ASL" -> "American Sign Language")
      const abbreviationMap: Record<string, string> = {
        'asl': 'american sign language',
        'engl': 'english',
        'advanced placement language and composition': 'ap english language',
        'ap language and composition': 'ap english language',
        'cisco network engineering': 'network engineering',
        'network engineering i/lab': 'network engineering 1',
        'network engineering i lab': 'network engineering 1',
      };
      let expandedPrereq = normalizedPrereq;
      
      // Remove "/Lab" and "/" separators for matching
      expandedPrereq = expandedPrereq.replace(/\/lab/gi, '');
      expandedPrereq = expandedPrereq.replace(/\/\s*/g, ' ');
      
      for (const [abbr, full] of Object.entries(abbreviationMap)) {
        if (expandedPrereq.includes(abbr)) {
          expandedPrereq = expandedPrereq.replace(abbr, full);
          break;
        }
      }
      
      // Handle "Presentation I" -> "Engineering Design and Presentation"
      if (normalizedPrereq.includes('presentation') && normalizedPrereq.includes('1')) {
        expandedPrereq = 'engineering design and presentation';
      }
      
      // Handle "Principles of Arts, Audio/Video Technology, and Communications" variations
      if (normalizedPrereq.includes('principles') && normalizedPrereq.includes('arts') && 
          (normalizedPrereq.includes('audio') || normalizedPrereq.includes('video'))) {
        // Try to match courses with "Arts" and "Audio" or "Video" in name
        for (const [courseName, courseCode] of nameToCodeMap.entries()) {
          const normalizedName = normalizeForMatching(courseName);
          if (normalizedName.includes('arts') && (normalizedName.includes('audio') || normalizedName.includes('video'))) {
            return courseCode;
          }
        }
      }

      // Try embedded pattern matching (e.g., "Athletics 1" matches "(Athletics 1)" in course name)
      for (const [courseName, courseCode] of nameToCodeMap.entries()) {
        const lowerName = courseName.toLowerCase();
        const normalizedName = normalizeForMatching(courseName);
        
        // Check if prerequisite appears in parentheses or as part of the name
        if (lowerName.includes(`(${lowerTrimmed})`) || lowerName.includes(`(${normalizedPrereq})`) || 
            lowerName.includes(`(${expandedPrereq})`)) {
          return courseCode;
        }
        
        // Check if the prerequisite is a substring of the course name (normalized)
        if (normalizedName.includes(normalizedPrereq) || normalizedName.includes(expandedPrereq)) {
          // Make sure it's not too generic (e.g., "1" matching everything)
          if (normalizedPrereq.length >= 3 || expandedPrereq.length >= 3) {
            return courseCode;
          }
        }
        
        // Check if the prerequisite is a substring of the course name (original)
        if (lowerName.includes(lowerTrimmed) || lowerName.includes(expandedPrereq)) {
          // Make sure it's not too generic (e.g., "1" matching everything)
          if (lowerTrimmed.length >= 3 || expandedPrereq.length >= 3) {
            return courseCode;
          }
        }
      }
      
      // Try matching base course name without number (e.g., "Journalism 3" -> "Journalism")
      // This handles cases where course sequences don't match exactly
      const baseNameMatch = trimmed.match(/^([A-Za-z\s]+)\s+[0-9IVX]+/i);
      if (baseNameMatch) {
        const baseName = baseNameMatch[1].trim();
        const normalizedBase = normalizeForMatching(baseName);
        for (const [courseName, courseCode] of nameToCodeMap.entries()) {
          const normalizedName = normalizeForMatching(courseName);
          if (normalizedName.startsWith(normalizedBase) || normalizedName.includes(normalizedBase)) {
            return courseCode;
          }
        }
      }
      
      // Try fuzzy matching for course names that contain the prerequisite
      // (e.g., "Presentation I" matches "Engineering Design and Presentation")
      const prereqWords = normalizedPrereq.split(/\s+/).filter(w => w.length > 2);
      if (prereqWords.length > 0) {
        for (const [courseName, courseCode] of nameToCodeMap.entries()) {
          const normalizedName = normalizeForMatching(courseName);
          // Check if all significant words from prerequisite appear in course name
          const allWordsMatch = prereqWords.every(word => normalizedName.includes(word));
          if (allWordsMatch && prereqWords.length >= 2) {
            return courseCode;
          }
        }
      }

      // Try partial match - find courses that start with the prerequisite name
      for (const [courseName, courseCode] of nameToCodeMap.entries()) {
        if (courseName.startsWith(trimmed) || trimmed.startsWith(courseName)) {
          return courseCode;
        }
      }

      // Try case-insensitive partial match
      for (const [courseName, courseCode] of nameToCodeMap.entries()) {
        const lowerName = courseName.toLowerCase();
        if (lowerName.startsWith(lowerTrimmed) || lowerTrimmed.startsWith(lowerName)) {
          return courseCode;
        }
      }

      return null;
    }

    /**
     * Converts a prerequisite string to course codes
     * Handles simple names, complex strings with "or", and compound prerequisites with "and" or "&"
     */
    function convertPrerequisite(prerequisite: string): string {
      if (!prerequisite || prerequisite.trim() === "" || prerequisite.toLowerCase() === "n/a") {
        return "n/a";
      }

      let trimmed = prerequisite.trim();
      
      // Clean up data quality issues
      if (trimmed.toLowerCase().startsWith('corequisite:')) {
        trimmed = trimmed.replace(/^corequisite:\s*/i, '').trim();
        if (trimmed.toLowerCase() === 'n/a' || trimmed === '') {
          return "n/a";
        }
      }

      // Check if it contains "or" (case-insensitive)
      const orPattern = /\s+or\s+/i;
      if (orPattern.test(trimmed)) {
        // Split by "or" and convert each part
        const parts = trimmed.split(orPattern).map(p => p.trim()).filter(p => p.length > 0);
        const convertedParts: string[] = [];
        let hasConversion = false;

        for (const part of parts) {
          // Skip standalone numbers (they're not course codes)
          if (/^\d+$/.test(part) || /^[IVX]+$/i.test(part)) {
            // Skip standalone numbers - they're not courses
            continue;
          }
          
          const code = findCourseCode(part);
          if (code && code !== part) {
            convertedParts.push(code);
            hasConversion = true;
          } else if (code) {
            // Already a course code
            convertedParts.push(code);
          } else {
            // If we can't find a match, keep the original part
            convertedParts.push(part);
          }
        }

        // Join with " or " if we have parts
        if (convertedParts.length > 0) {
          return convertedParts.join(" or ");
        }
      }

      // Check if it contains "and" or "&" (compound prerequisites)
      const andPattern = /\s+(and|&)\s+/i;
      if (andPattern.test(trimmed)) {
        // Split by "and" or "&" and convert each part
        const parts = trimmed.split(andPattern).map(p => p.trim()).filter(p => p.length > 0 && !/^(and|&)$/i.test(p));
        const convertedParts: string[] = [];
        let hasNonCourseText = false;

        for (const part of parts) {
          // Check if part contains non-course text (like "2 credits", "of high school", etc.)
          const nonCoursePattern = /\d+\s*(credit|credits|hours?)\s*(of|in)|of\s+(high\s+school|college)/i;
          if (nonCoursePattern.test(part)) {
            convertedParts.push(part);
            hasNonCourseText = true;
            continue;
          }
          
          const code = findCourseCode(part);
          if (code && code !== part) {
            convertedParts.push(code);
          } else if (code) {
            // Already a course code
            convertedParts.push(code);
          } else {
            // If we can't find a match, keep the original part
            convertedParts.push(part);
          }
        }

        // Join with " or " if all parts are course codes, otherwise keep " and "
        if (convertedParts.length > 0) {
          const allMatched = convertedParts.every(p => /^[A-Z0-9]+$/.test(p)); // All are course codes
          if (allMatched && !hasNonCourseText) {
            return convertedParts.join(" or "); // Use "or" for prerequisites when all are codes
          } else {
            return convertedParts.join(" and "); // Keep "and" if some didn't match or has non-course text
          }
        }
      }

      // Simple prerequisite - try to find matching course code
      const code = findCourseCode(trimmed);
      if (code) {
        return code;
      }

      // No match found - return original (will be logged as warning)
      return trimmed;
    }

    // Convert prerequisites
    console.log("Converting prerequisites...");
    let updatedCount = 0;
    let unchangedCount = 0;
    let schoolsFixedCount = 0;
    const unmatchedPrerequisites = new Map<string, number>();

    for (let i = 0; i < catalog.courses.length; i++) {
      const course = catalog.courses[i];
      
      // Ensure required fields exist (fix for missing schools field)
      if (!course.schools || !Array.isArray(course.schools)) {
        course.schools = [];
        schoolsFixedCount++;
      }
      
      const originalPrerequisite = course.prerequisite;
      const convertedPrerequisite = convertPrerequisite(originalPrerequisite);

      if (originalPrerequisite !== convertedPrerequisite) {
        course.prerequisite = convertedPrerequisite;
        updatedCount++;
      } else {
        unchangedCount++;
      }

      // Track unmatched prerequisites (those that weren't "n/a" and didn't change)
      // Skip if it's already a course code (those are fine)
      const trimmedOriginal = originalPrerequisite?.trim() || '';
      const isAlreadyCode = trimmedOriginal && (
        isCourseCode(trimmedOriginal) || 
        (trimmedOriginal.includes(' or ') && trimmedOriginal.split(/\s+or\s+/i).every((p: string) => isCourseCode(p.trim())))
      );
      
      if (
        originalPrerequisite &&
        originalPrerequisite.toLowerCase() !== "n/a" &&
        originalPrerequisite === convertedPrerequisite &&
        !nameToCodeMap.has(trimmedOriginal) &&
        !isAlreadyCode
      ) {
        const count = unmatchedPrerequisites.get(originalPrerequisite) || 0;
        unmatchedPrerequisites.set(originalPrerequisite, count + 1);
      }

      // Log progress every 500 courses
      if ((i + 1) % 500 === 0) {
        console.log(`Processed ${i + 1}/${catalog.courses.length} courses...`);
      }
    }

    console.log(`\nUpdated ${updatedCount} prerequisites`);
    console.log(`Unchanged ${unchangedCount} prerequisites (mostly "n/a" or already course codes)`);
    if (schoolsFixedCount > 0) {
      console.log(`Fixed ${schoolsFixedCount} courses with missing schools field`);
    }
    
    // Count how many prerequisites are already course codes
    let alreadyCodesCount = 0;
    for (const course of catalog.courses) {
      const prereq = course.prerequisite?.trim() || '';
      if (prereq && prereq.toLowerCase() !== 'n/a') {
        if (isCourseCode(prereq) || (prereq.includes(' or ') && prereq.split(/\s+or\s+/i).every((p: string) => isCourseCode(p.trim())))) {
          alreadyCodesCount++;
        }
      }
    }
    if (alreadyCodesCount > 0) {
      console.log(`Note: ${alreadyCodesCount} prerequisites were already course codes (no conversion needed)`);
    }

    // Report unmatched prerequisites
    if (unmatchedPrerequisites.size > 0) {
      console.log(`\nWarning: Found ${unmatchedPrerequisites.size} unmatched prerequisites:`);
      const sorted = Array.from(unmatchedPrerequisites.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
      for (const [prereq, count] of sorted) {
        console.log(`  "${prereq}" (${count} occurrence${count > 1 ? "s" : ""})`);
      }
      if (unmatchedPrerequisites.size > 20) {
        console.log(`  ... and ${unmatchedPrerequisites.size - 20} more`);
      }
      console.log("\nThese prerequisites were kept as-is (original course names)");
    }

    // Validate the updated catalog against schema
    console.log("\nValidating updated catalog...");
    const validated = CourseCatalogSchema.parse(catalog);
    console.log("✓ Validation passed");

    // Write updated data back to file
    console.log(`\nWriting updated data to ${OUTPUT_FILE}...`);
    await fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify(validated, null, 2),
      "utf-8"
    );

    console.log("\n✓ Migration completed successfully!");
    console.log(`Total courses: ${catalog.courses.length}`);
    console.log(`Prerequisites updated: ${updatedCount}`);
    console.log(`Prerequisites unchanged: ${unchangedCount}`);

  } catch (error) {
    // Safely log error without triggering util.inspect issues
    console.error("\n✗ Migration failed");
    if (error instanceof Error) {
      console.error("Error message:", error.message);
      if (error.stack) {
        console.error("Stack trace:", error.stack);
      }
      // If it's a Zod error, try to log issues safely
      if ((error as any).issues && Array.isArray((error as any).issues)) {
        console.error(`Validation errors: ${(error as any).issues.length} issue(s) found`);
        try {
          const firstIssue = (error as any).issues[0];
          if (firstIssue) {
            console.error("First error:", {
              path: firstIssue.path,
              code: firstIssue.code,
              message: firstIssue.message
            });
          }
        } catch (e) {
          // Ignore if we can't extract issue details
        }
      }
    } else {
      // For non-Error objects, try to stringify safely
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

