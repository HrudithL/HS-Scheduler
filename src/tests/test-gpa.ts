import { promises as fs } from "fs";
import * as path from "path";
import { chromium, Page } from "playwright";
import {
  findScrollContainer,
  findCourseCards,
  findCourseRowByCode,
  extractDetailFields,
  expandCourseCard,
  collapseCourseCard,
  retryOperation,
  CourseCardInfo,
} from "../dom";
import {
  Course,
  calculateGPA,
  createCourse,
  CourseSchema,
} from "../schema";

const TARGET_URL =
  "https://app.schoolinks.com/course-catalog/katy-isd/course-offerings";
const TEST_COURSE_LIMIT = 20; // Scrape a small number of courses for testing

const OUTPUT_FILE = path.join("output", "courses.katy-isd.json");

/**
 * Dismisses cookie banners or popups if present
 */
async function dismissPopups(page: Page): Promise<void> {
  try {
    const acceptButton = page.getByRole("button", {
      name: /accept|agree|continue|ok/i,
    });
    
    const count = await acceptButton.count();
    if (count > 0) {
      await acceptButton.first().click({ timeout: 2000 });
      console.log("Dismissed popup/banner");
      await page.waitForTimeout(500);
    }
  } catch (error) {
    // No popup found or couldn't dismiss - not critical
  }
}

/**
 * Extracts full course data by expanding the card to get details
 */
async function extractCourseData(
  cardInfo: CourseCardInfo,
  index: number,
  page: Page
): Promise<Course | null> {
  try {
    // Find the row by course code (stable selector that doesn't shift)
    const row = await findCourseRowByCode(page, cardInfo.courseCode);
    
    if (!row) {
      console.warn(`Course ${index + 1}: Could not locate row for ${cardInfo.courseCode}`);
      return null;
    }

    // Expand the card with retry logic
    await retryOperation(
      async () => {
        await expandCourseCard(row, page);
      },
      2,
      500
    );

    // Extract detail fields from the expanded row
    const detailFields = await extractDetailFields(row, page);

    // Collapse the card to prevent DOM bloat
    await collapseCourseCard(row, page);

    // Create and validate the course object (this will automatically calculate GPA)
    const courseData = createCourse({
      courseCode: cardInfo.courseCode,
      courseName: cardInfo.courseName,
      credits: cardInfo.credits,
      tags: cardInfo.tags,
      subject: detailFields.subject,
      term: detailFields.term,
      eligibleGrades: detailFields.eligibleGrades,
      prerequisite: detailFields.prerequisite,
      corequisite: detailFields.corequisite,
      enrollmentNotes: detailFields.enrollmentNotes,
      courseDescription: detailFields.courseDescription,
    });

    // Validate with Zod
    const validated = CourseSchema.parse(courseData);
    return validated;
  } catch (error) {
    console.error(
      `Error extracting course ${index + 1} (${cardInfo.courseCode}):`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/**
 * Test script to validate GPA calculation logic by scraping courses
 * Does NOT modify the existing JSON file
 */
async function main(): Promise<void> {
  console.log("GPA Calculation Test (with Scraping)");
  console.log("=====================================\n");

  let passedTests = 0;
  let failedTests = 0;

  // Test 1: AP course by tag
  console.log("Test 1: AP course by tag");
  const gpa1 = calculateGPA("Some Course", ["AP"]);
  if (gpa1 === 5.0) {
    console.log("  ✓ PASS: AP tag returns 5.0 GPA");
    passedTests++;
  } else {
    console.log(`  ✗ FAIL: Expected 5.0, got ${gpa1}`);
    failedTests++;
  }

  // Test 2: AP course by name
  console.log("\nTest 2: AP course by name");
  const gpa2 = calculateGPA("AP English Literature", []);
  if (gpa2 === 5.0) {
    console.log("  ✓ PASS: AP in name returns 5.0 GPA");
    passedTests++;
  } else {
    console.log(`  ✗ FAIL: Expected 5.0, got ${gpa2}`);
    failedTests++;
  }

  // Test 3: KAP course by tag
  console.log("\nTest 3: KAP course by tag");
  const gpa3 = calculateGPA("Some Course", ["KAP"]);
  if (gpa3 === 5.0) {
    console.log("  ✓ PASS: KAP tag returns 5.0 GPA");
    passedTests++;
  } else {
    console.log(`  ✗ FAIL: Expected 5.0, got ${gpa3}`);
    failedTests++;
  }

  // Test 4: KAP course by name
  console.log("\nTest 4: KAP course by name");
  const gpa4 = calculateGPA("English 1 KAP A", []);
  if (gpa4 === 5.0) {
    console.log("  ✓ PASS: KAP in name returns 5.0 GPA");
    passedTests++;
  } else {
    console.log(`  ✗ FAIL: Expected 5.0, got ${gpa4}`);
    failedTests++;
  }

  // Test 5: Dual Credit by tag
  console.log("\nTest 5: Dual Credit course by tag");
  const gpa5 = calculateGPA("Some Course", ["DC"]);
  if (gpa5 === 4.5) {
    console.log("  ✓ PASS: DC tag returns 4.5 GPA");
    passedTests++;
  } else {
    console.log(`  ✗ FAIL: Expected 4.5, got ${gpa5}`);
    failedTests++;
  }

  // Test 6: Dual Credit by name
  console.log("\nTest 6: Dual Credit course by name");
  const gpa6 = calculateGPA("English 4 A (Dual Credit English 1301/1302)", []);
  if (gpa6 === 4.5) {
    console.log("  ✓ PASS: Dual Credit in name returns 4.5 GPA");
    passedTests++;
  } else {
    console.log(`  ✗ FAIL: Expected 4.5, got ${gpa6}`);
    failedTests++;
  }

  // Test 7: Regular course
  console.log("\nTest 7: Regular course (no AP/KAP/Dual Credit)");
  const gpa7 = calculateGPA("Study Hall", []);
  if (gpa7 === 4.0) {
    console.log("  ✓ PASS: Regular course returns 4.0 GPA");
    passedTests++;
  } else {
    console.log(`  ✗ FAIL: Expected 4.0, got ${gpa7}`);
    failedTests++;
  }

  // Test 8: AP takes precedence over Dual Credit
  console.log("\nTest 8: AP takes precedence over Dual Credit");
  const gpa8 = calculateGPA("AP Dual Credit Course", ["DC"]);
  if (gpa8 === 5.0) {
    console.log("  ✓ PASS: AP takes precedence, returns 5.0 GPA");
    passedTests++;
  } else {
    console.log(`  ✗ FAIL: Expected 5.0 (AP precedence), got ${gpa8}`);
    failedTests++;
  }

  // Test 9: Case insensitivity
  console.log("\nTest 9: Case insensitivity");
  const gpa9a = calculateGPA("ap course", []);
  const gpa9b = calculateGPA("KAP course", []);
  const gpa9c = calculateGPA("dual credit course", []);
  if (gpa9a === 5.0 && gpa9b === 5.0 && gpa9c === 4.5) {
    console.log("  ✓ PASS: Case insensitive matching works");
    passedTests++;
  } else {
    console.log(`  ✗ FAIL: Case insensitivity failed (AP: ${gpa9a}, KAP: ${gpa9b}, Dual: ${gpa9c})`);
    failedTests++;
  }

  // Test 10: Scrape courses and validate GPA assignment
  console.log("\n" + "=".repeat(50));
  console.log("Test 10: Scraping courses and validating GPA assignment");
  console.log("=".repeat(50) + "\n");

  console.log(`Scraping ${TEST_COURSE_LIMIT} courses from ${TARGET_URL}...\n`);

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const page = await browser.newPage();
    
    // Navigate to the page
    console.log(`Navigating to ${TARGET_URL}...`);
    await page.goto(TARGET_URL, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    // Dismiss any popups
    await dismissPopups(page);

    // Wait for React to render course list
    console.log("Waiting for course list to render...");
    try {
      await page.waitForSelector('tr, [class*="course"], [data-testid*="course"]', { timeout: 10000 });
    } catch (error) {
      console.warn("Course list selector not found, continuing anyway...");
    }
    await page.waitForTimeout(2000);

    // Scroll to load courses (limited to TEST_COURSE_LIMIT)
    const scrollContainer = await findScrollContainer(page);
    let previousCount = 0;
    let iteration = 0;
    const maxIterations = Math.ceil(TEST_COURSE_LIMIT / 10) * 2;

    while (iteration < maxIterations) {
      iteration++;
      const cardsBefore = await findCourseCards(page);
      const countBefore = cardsBefore.length;

      if (countBefore >= TEST_COURSE_LIMIT) {
        console.log(`Loaded ${countBefore} courses (target: ${TEST_COURSE_LIMIT})`);
        break;
      }

      // Scroll to bottom
      for (let scrollAttempt = 0; scrollAttempt < 3; scrollAttempt++) {
        await scrollContainer.evaluate((el: any) => {
          el.scrollTop = el.scrollHeight;
        });
        await page.waitForTimeout(500);
      }

      await page.waitForTimeout(2500);

      const cardsAfter = await findCourseCards(page);
      const countAfter = cardsAfter.length;

      if (countAfter > previousCount) {
        previousCount = countAfter;
      } else if (countAfter === previousCount && countAfter >= TEST_COURSE_LIMIT) {
        break;
      }
    }

    // Get course info
    const courseInfoList = await findCourseCards(page);
    const coursesToProcess = courseInfoList.slice(0, TEST_COURSE_LIMIT);
    console.log(`\nProcessing ${coursesToProcess.length} courses for GPA validation...\n`);

    // Scrape and validate courses
    let scrapedCourses: Course[] = [];
    let gpaValidationPassed = 0;
    let gpaValidationFailed = 0;

    for (let i = 0; i < coursesToProcess.length; i++) {
      const cardInfo = coursesToProcess[i];
      console.log(`Scraping course ${i + 1}/${coursesToProcess.length}: ${cardInfo.courseCode} - ${cardInfo.courseName}`);

      const courseData = await extractCourseData(cardInfo, i, page);

      if (courseData) {
        scrapedCourses.push(courseData);

        // Validate GPA is present
        if (courseData.gpa === undefined || courseData.gpa === null) {
          console.log(`  ✗ FAIL: Course ${cardInfo.courseCode} missing GPA field`);
          gpaValidationFailed++;
        } else {
          // Validate GPA is correct
          const expectedGPA = calculateGPA(courseData.courseName, courseData.tags);
          if (courseData.gpa === expectedGPA) {
            console.log(`  ✓ PASS: ${cardInfo.courseCode} has correct GPA (${courseData.gpa})`);
            gpaValidationPassed++;
          } else {
            console.log(`  ✗ FAIL: ${cardInfo.courseCode} has incorrect GPA (expected ${expectedGPA}, got ${courseData.gpa})`);
            gpaValidationFailed++;
          }
        }
      } else {
        console.log(`  ⚠ WARN: Could not extract course data for ${cardInfo.courseCode}`);
      }
    }

    console.log(`\nGPA Validation Results:`);
    console.log(`  Passed: ${gpaValidationPassed}`);
    console.log(`  Failed: ${gpaValidationFailed}`);
    console.log(`  Total scraped: ${scrapedCourses.length}`);

    if (gpaValidationFailed === 0 && scrapedCourses.length > 0) {
      console.log("\n  ✓ PASS: All scraped courses have correct GPAs assigned");
      passedTests++;
    } else if (scrapedCourses.length === 0) {
      console.log("\n  ⚠ WARN: No courses were successfully scraped");
      failedTests++;
    } else {
      console.log("\n  ✗ FAIL: Some courses have incorrect or missing GPAs");
      failedTests++;
    }

    // Show GPA distribution of scraped courses
    if (scrapedCourses.length > 0) {
      const gpaDistribution = scrapedCourses.reduce((acc: Record<string, number>, course) => {
        const gpa = course.gpa.toString();
        acc[gpa] = (acc[gpa] || 0) + 1;
        return acc;
      }, {});

      console.log("\nGPA Distribution of Scraped Courses:");
      Object.entries(gpaDistribution)
        .sort(([a], [b]) => parseFloat(b) - parseFloat(a))
        .forEach(([gpa, count]) => {
          console.log(`  ${gpa}: ${count} courses`);
        });
    }

    await browser.close();
  } catch (error) {
    console.error("\n✗ Error during scraping:", error);
    await browser.close();
    failedTests++;
  }

  // Test against real data from JSON file
  console.log("\n" + "=".repeat(50));
  console.log("Testing against real course data from JSON file");
  console.log("=".repeat(50) + "\n");

  try {
    const data = await fs.readFile(OUTPUT_FILE, "utf-8");
    const catalog = JSON.parse(data);

    if (!catalog.courses || !Array.isArray(catalog.courses)) {
      throw new Error("Invalid catalog structure");
    }

    console.log(`Found ${catalog.courses.length} courses in JSON file\n`);

    // Find examples of each type
    const apCourses = catalog.courses.filter((c: any) => 
      c.courseName?.toUpperCase().includes("AP") || c.tags?.includes("AP")
    ).slice(0, 5);

    const kapCourses = catalog.courses.filter((c: any) => 
      c.courseName?.toUpperCase().includes("KAP") || c.tags?.includes("KAP")
    ).slice(0, 5);

    const dualCreditCourses = catalog.courses.filter((c: any) => 
      c.courseName?.toUpperCase().includes("DUAL CREDIT") || c.tags?.includes("DC")
    ).slice(0, 5);

    const regularCourses = catalog.courses.filter((c: any) => {
      const name = c.courseName?.toUpperCase() || "";
      const tags = (c.tags || []).map((t: string) => t.toUpperCase());
      return !name.includes("AP") && !name.includes("KAP") && 
             !name.includes("DUAL CREDIT") && 
             !tags.includes("AP") && !tags.includes("KAP") && !tags.includes("DC");
    }).slice(0, 5);

    // Test AP courses
    console.log("Testing AP courses from JSON:");
    let apPassed = 0;
    for (const course of apCourses) {
      const calculatedGPA = calculateGPA(course.courseName, course.tags || []);
      const expectedGPA = course.gpa !== undefined ? course.gpa : 5.0;
      if (calculatedGPA === expectedGPA || calculatedGPA === 5.0) {
        console.log(`  ✓ ${course.courseCode}: "${course.courseName}" → ${calculatedGPA} GPA`);
        apPassed++;
      } else {
        console.log(`  ✗ ${course.courseCode}: Expected ${expectedGPA}, got ${calculatedGPA}`);
      }
    }
    if (apPassed === apCourses.length) {
      passedTests++;
    } else {
      failedTests++;
    }

    // Test KAP courses
    console.log("\nTesting KAP courses from JSON:");
    let kapPassed = 0;
    for (const course of kapCourses) {
      const calculatedGPA = calculateGPA(course.courseName, course.tags || []);
      const expectedGPA = course.gpa !== undefined ? course.gpa : 5.0;
      if (calculatedGPA === expectedGPA || calculatedGPA === 5.0) {
        console.log(`  ✓ ${course.courseCode}: "${course.courseName}" → ${calculatedGPA} GPA`);
        kapPassed++;
      } else {
        console.log(`  ✗ ${course.courseCode}: Expected ${expectedGPA}, got ${calculatedGPA}`);
      }
    }
    if (kapPassed === kapCourses.length) {
      passedTests++;
    } else {
      failedTests++;
    }

    // Test Dual Credit courses
    console.log("\nTesting Dual Credit courses from JSON:");
    let dcPassed = 0;
    for (const course of dualCreditCourses) {
      const calculatedGPA = calculateGPA(course.courseName, course.tags || []);
      const expectedGPA = course.gpa !== undefined ? course.gpa : 4.5;
      if (calculatedGPA === expectedGPA || calculatedGPA === 4.5) {
        console.log(`  ✓ ${course.courseCode}: "${course.courseName}" → ${calculatedGPA} GPA`);
        dcPassed++;
      } else {
        console.log(`  ✗ ${course.courseCode}: Expected ${expectedGPA}, got ${calculatedGPA}`);
      }
    }
    if (dcPassed === dualCreditCourses.length) {
      passedTests++;
    } else {
      failedTests++;
    }

    // Test regular courses
    console.log("\nTesting regular courses from JSON:");
    let regularPassed = 0;
    for (const course of regularCourses) {
      const calculatedGPA = calculateGPA(course.courseName, course.tags || []);
      const expectedGPA = course.gpa !== undefined ? course.gpa : 4.0;
      if (calculatedGPA === expectedGPA || calculatedGPA === 4.0) {
        console.log(`  ✓ ${course.courseCode}: "${course.courseName}" → ${calculatedGPA} GPA`);
        regularPassed++;
      } else {
        console.log(`  ✗ ${course.courseCode}: Expected ${expectedGPA}, got ${calculatedGPA}`);
      }
    }
    if (regularPassed === regularCourses.length) {
      passedTests++;
    } else {
      failedTests++;
    }

  } catch (error) {
    console.log(`\n⚠ Could not test against JSON file: ${error instanceof Error ? error.message : error}`);
    console.log("(This is okay if the file doesn't exist yet or hasn't been migrated)");
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("Test Summary");
  console.log("=".repeat(50));
  console.log(`Passed: ${passedTests}`);
  console.log(`Failed: ${failedTests}`);
  console.log(`Total:  ${passedTests + failedTests}`);

  if (failedTests === 0) {
    console.log("\n✓ All tests passed!");
    process.exit(0);
  } else {
    console.log("\n✗ Some tests failed");
    process.exit(1);
  }
}

// Run the tests
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

