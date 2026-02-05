import { promises as fs } from "fs";
import * as path from "path";
import { CourseCatalogSchema, calculateGPA } from "./schema";

const OUTPUT_FILE = path.join("output", "courses.katy-isd.json");

/**
 * Migration script to add GPA field to existing course data
 */
async function main(): Promise<void> {
  console.log("GPA Migration Script");
  console.log("====================\n");

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

    // Calculate and add GPA to each course
    let updatedCount = 0;
    for (let i = 0; i < catalog.courses.length; i++) {
      const course = catalog.courses[i];
      
      // Skip if GPA already exists (idempotent)
      if (course.gpa !== undefined) {
        continue;
      }

      // Calculate GPA using the same function as createCourse
      const gpa = calculateGPA(course.courseName, course.tags || []);
      course.gpa = gpa;
      updatedCount++;

      // Log progress every 100 courses
      if ((i + 1) % 100 === 0) {
        console.log(`Processed ${i + 1}/${catalog.courses.length} courses...`);
      }
    }

    console.log(`\nUpdated ${updatedCount} courses with GPA values`);

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
    console.log(`Courses updated: ${updatedCount}`);

    // Show GPA distribution
    const gpaDistribution = catalog.courses.reduce((acc: Record<string, number>, course: any) => {
      const gpa = course.gpa.toString();
      acc[gpa] = (acc[gpa] || 0) + 1;
      return acc;
    }, {});

    console.log("\nGPA Distribution:");
    Object.entries(gpaDistribution)
      .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
      .forEach(([gpa, count]) => {
        console.log(`  ${gpa}: ${count} courses`);
      });

  } catch (error) {
    console.error("\n✗ Migration failed:", error);
    if (error instanceof Error) {
      console.error("Error message:", error.message);
    }
    process.exit(1);
  }
}

// Run the migration
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

