import { chromium, Page } from "playwright";
import { promises as fs } from "fs";
import * as path from "path";
import {
  findScrollContainer,
  findCourseCards,
  findCourseRowByCode,
  extractDetailFields,
  expandCourseCard,
  collapseCourseCard,
  retryOperation,
  CourseCardInfo,
} from "./dom";
import {
  Course,
  CourseCatalogSchema,
  createCourse,
  CourseSchema,
} from "./schema";

const TARGET_URL =
  "https://app.schoolinks.com/course-catalog/katy-isd/course-offerings";
const DISTRICT = "katy-isd";
const OUTPUT_DIR = "output";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "courses.katy-isd.json");
const CHECKPOINT_FILE = path.join(OUTPUT_DIR, "courses.katy-isd.partial.json");

const CHECKPOINT_INTERVAL = 100; // Save every 100 courses
const PROGRESS_LOG_INTERVAL = 50; // Log every 50 courses
const MAX_SCROLL_ATTEMPTS = 15; // Stop scrolling after count is stable for this many attempts

/**
 * Scrolls the page to load courses via infinite scroll
 * @param page - Playwright page object
 * @param limit - Optional limit on number of courses to load (null = load all)
 */
async function scrollToLoadCourses(page: Page, limit: number | null = null): Promise<number> {
  if (limit) {
    console.log(`Loading courses via infinite scroll (target: ${limit} courses)...`);
  } else {
    console.log("Loading all courses via infinite scroll...");
  }
  
  const scrollContainer = await findScrollContainer(page);
  let previousCount = 0;
  let stableCount = 0;
  let maxIterations = limit ? Math.ceil(limit / 10) * 2 : 1000; // Allow many iterations when no limit
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;
    
    // Get initial course count before scrolling
    const cardsBefore = await findCourseCards(page);
    const countBefore = cardsBefore.length;
    
    if (iteration === 1) {
      previousCount = countBefore;
      console.log(`Initial course count: ${countBefore}`);
    } else {
      console.log(`Found ${countBefore} courses (previously: ${previousCount})`);
    }

    // If we have a limit and reached it, stop scrolling
    if (limit && countBefore >= limit) {
      console.log(`Reached target limit of ${limit} courses. Stopping scroll.`);
      return countBefore;
    }

    // Scroll to bottom multiple times to ensure we trigger lazy loading
    for (let scrollAttempt = 0; scrollAttempt < 3; scrollAttempt++) {
      await scrollContainer.evaluate((el: any) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(500); // Wait between scroll attempts
    }

    // Wait for new content to load - use longer wait times
    await page.waitForTimeout(2500);

    // Check course count after waiting
    const cardsAfter = await findCourseCards(page);
    const countAfter = cardsAfter.length;
    
    // Check if new courses were found
    if (countAfter > previousCount) {
      // New courses found - reset stable count and continue
      const newCourses = countAfter - previousCount;
      console.log(`✓ Found ${newCourses} new course(s)! Total: ${countAfter} (increased from ${previousCount})`);
      stableCount = 0;
      previousCount = countAfter;
      
      // Continue scrolling to find more courses
      continue;
    } else if (countAfter === previousCount) {
      // No new courses found - increment stable count
      stableCount++;
      console.log(`No new courses found (count stable: ${stableCount}/${MAX_SCROLL_ATTEMPTS})`);
      
      // Only stop if count has been stable for MAX_SCROLL_ATTEMPTS consecutive iterations
      // This ensures we've truly reached the end and no more courses are loading
      if (stableCount >= MAX_SCROLL_ATTEMPTS) {
        console.log(`Course count has been stable for ${MAX_SCROLL_ATTEMPTS} consecutive attempts. All courses loaded.`);
        break;
      }
      
      // Even if count is stable, try scrolling a few more times in case content is loading slowly
      // Scroll one more time and wait longer
      await scrollContainer.evaluate((el: any) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(3000); // Wait even longer for slow-loading content
      
      // Check one more time after extended wait
      const cardsFinal = await findCourseCards(page);
      const countFinal = cardsFinal.length;
      
      if (countFinal > countAfter) {
        // Found more courses after extended wait - reset and continue
        const newCourses = countFinal - countAfter;
        console.log(`✓ Found ${newCourses} additional course(s) after extended wait! Total: ${countFinal}`);
        stableCount = 0;
        previousCount = countFinal;
        continue;
      }
    } else {
      // Count decreased (shouldn't happen, but handle it)
      console.warn(`Course count decreased (${previousCount} -> ${countAfter}). Resetting stable count.`);
      stableCount = 0;
      previousCount = countAfter;
    }
  }

  // Get final count
  const finalCards = await findCourseCards(page);
  const finalCount = finalCards.length;
  console.log(`Finished loading. Total courses: ${finalCount}`);
  return finalCount;
}

/**
 * Loads checkpoint data if it exists
 */
async function loadCheckpoint(): Promise<{
  courses: Course[];
  processedCodes: Set<string>;
}> {
  try {
    const data = await fs.readFile(CHECKPOINT_FILE, "utf-8");
    const courses = JSON.parse(data) as Course[];
    const processedCodes = new Set(courses.map((c) => c.courseCode));
    console.log(`Loaded checkpoint with ${courses.length} courses`);
    return { courses, processedCodes };
  } catch (error) {
    // No checkpoint exists or error reading it
    return { courses: [], processedCodes: new Set() };
  }
}

/**
 * Saves checkpoint data
 */
async function saveCheckpoint(courses: Course[]): Promise<void> {
  try {
    await fs.writeFile(
      CHECKPOINT_FILE,
      JSON.stringify(courses, null, 2),
      "utf-8"
    );
    console.log(`Checkpoint saved: ${courses.length} courses`);
  } catch (error) {
    console.error("Error saving checkpoint:", error);
  }
}

/**
 * Saves the final output
 */
async function saveFinalOutput(courses: Course[]): Promise<void> {
  try {
    // Create catalog object with source metadata at top level
    const catalog = {
      source: {
        district: DISTRICT,
        url: TARGET_URL,
      },
      courses: courses,
    };
    
    // Validate the entire catalog
    const validated = CourseCatalogSchema.parse(catalog);
    
    await fs.writeFile(
      OUTPUT_FILE,
      JSON.stringify(validated, null, 2),
      "utf-8"
    );
    console.log(`\nFinal output saved: ${OUTPUT_FILE}`);
    console.log(`Total courses: ${courses.length}`);
    
    // Delete checkpoint file
    try {
      await fs.unlink(CHECKPOINT_FILE);
      console.log("Checkpoint file removed");
    } catch {
      // Ignore if checkpoint doesn't exist
    }
  } catch (error) {
    console.error("Error saving final output:", error);
    throw error;
  }
}

/**
 * Dismisses cookie banners or popups if present
 */
async function dismissPopups(page: Page): Promise<void> {
  try {
    // Look for common cookie banner buttons
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
    console.log(
      `Processing course ${index + 1}: ${cardInfo.courseCode} - ${cardInfo.courseName}`
    );

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

    // Create and validate the course object
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
 * Main scraper function
 */
async function main(): Promise<void> {
  console.log("SchooLinks Course Catalog Scraper");
  console.log("==================================\n");

  // Check for test mode (limit to first N courses)
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const testLimit = limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : null;

  if (testLimit) {
    console.log(`TEST MODE: Limited to first ${testLimit} courses\n`);
  }

  // Load checkpoint if it exists
  const { courses: existingCourses, processedCodes } = await loadCheckpoint();
  const courses: Course[] = [...existingCourses];

  // Launch browser
  console.log("Launching browser...");
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
    await page.waitForTimeout(2000); // Additional wait for dynamic content

    // Scroll to load courses (with limit if in test mode)
    const targetLimit = testLimit ? testLimit * 2 : null; // Load more rows than needed since some are detail rows
    const loadedCount = await scrollToLoadCourses(page, targetLimit);

    // Get all course info (extracted upfront to avoid DOM mutation issues)
    const courseInfoList = await findCourseCards(page);
    console.log(`\nFound ${courseInfoList.length} unique courses after scroll`);

    if (courseInfoList.length === 0) {
      console.error("No course cards found! Check the DOM selectors.");
      await page.screenshot({ path: "debug-no-courses.png" });
      return;
    }

    // Apply test limit if specified (take only the first N unique courses)
    const coursesToProcess = testLimit ? courseInfoList.slice(0, testLimit) : courseInfoList;
    console.log(`Processing ${coursesToProcess.length} courses...\n`);

    // Process each course
    let successCount = 0;
    let errorCount = 0;
    let duplicateCount = 0;

    for (let i = 0; i < coursesToProcess.length; i++) {
      const cardInfo = coursesToProcess[i];

      // Check if already processed (from checkpoint)
      if (processedCodes.has(cardInfo.courseCode)) {
        console.log(`Course ${i + 1}: ${cardInfo.courseCode} already processed (checkpoint), skipping`);
        duplicateCount++;
        continue;
      }

      // Extract full course data (with details from expansion)
      const courseData = await extractCourseData(cardInfo, i, page);

      if (courseData) {
        // Validate course has required fields
        if (!courseData.courseCode || !courseData.courseName) {
          console.warn(`Course ${i + 1}: Missing required fields (code: ${courseData.courseCode}, name: ${courseData.courseName}), skipping`);
          errorCount++;
          continue;
        }
        
        courses.push(courseData);
        processedCodes.add(courseData.courseCode);
        successCount++;
      } else {
        errorCount++;
      }

      // Log progress
      if ((i + 1) % PROGRESS_LOG_INTERVAL === 0 || (i + 1) === coursesToProcess.length) {
        console.log(
          `\nProgress: ${i + 1}/${coursesToProcess.length} (${successCount} successful, ${errorCount} errors, ${duplicateCount} duplicates)`
        );
      }

      // Save checkpoint
      if (courses.length % CHECKPOINT_INTERVAL === 0 && courses.length > 0) {
        await saveCheckpoint(courses);
      }
    }

    console.log(`\n\nScraping complete!`);
    console.log(`Successful: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Duplicates skipped: ${duplicateCount}`);
    console.log(`Total courses extracted: ${courses.length}`);
    
    // Validate final output
    if (courses.length === 0) {
      console.error("\nWARNING: No courses were extracted! Check the extraction logic.");
      return;
    }
    
    // Verify courses have required fields
    const invalidCourses = courses.filter(c => !c.courseCode || !c.courseName);
    if (invalidCourses.length > 0) {
      console.warn(`\nWARNING: ${invalidCourses.length} courses have missing required fields`);
    }

    // Save final output
    await saveFinalOutput(courses);
  } catch (error) {
    console.error("\n\nFatal error during scraping:", error);
    
    // Save what we have so far
    if (courses.length > 0) {
      console.log("\nSaving partial results...");
      await saveCheckpoint(courses);
    }
    
    throw error;
  } finally {
    await browser.close();
  }
}

// Run the scraper
main().catch((error) => {
  console.error("Scraper failed:", error);
  process.exit(1);
});

