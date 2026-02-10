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
  getAvailableSchools,
  selectSchool,
  waitForSchoolFilterUpdate,
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
const OUTPUT_SCHOOLS_DIR = path.join(OUTPUT_DIR, "schools");

const PROGRESS_LOG_INTERVAL = 50; // Log every 50 courses
const MAX_SCROLL_ATTEMPTS = 15; // Stop scrolling after count is stable for this many attempts
const CHECKPOINT_INTERVAL = 200; // Save progress every 200 courses

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
  
  // #region agent log
  const initialState = await page.evaluate(() => {
    const schoolFilterValue = (document.querySelector('#school-filter') as HTMLInputElement)?.value || '';
    const rowCount = document.querySelectorAll('tr').length;
    return { schoolFilterValue, rowCount };
  });
  fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'scrape.ts:39',message:'scrollToLoadCourses: initial state',data:initialState,timestamp:Date.now(),runId:'debug1',hypothesisId:'E'})}).catch(()=>{});
  // #endregion

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
 * Now includes the school name that this course belongs to
 */
async function extractCourseData(
  cardInfo: CourseCardInfo,
  index: number,
  page: Page,
  schoolName: string
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
    let expansionSucceeded = false;
    try {
      await retryOperation(
        async () => {
          await expandCourseCard(row, page);
        },
        2,
        500
      );
      expansionSucceeded = true;
    } catch (error) {
      // Expansion failed - we'll still try to extract what we can
      console.warn(`Course ${index + 1}: Could not expand card, will extract basic info only`);
    }

    // Extract detail fields from the expanded row (or empty if expansion failed)
    let detailFields;
    if (expansionSucceeded) {
      detailFields = await extractDetailFields(row, page);
      
      // Collapse the card to prevent DOM bloat (only if we expanded it)
      try {
        await collapseCourseCard(row, page);
      } catch (error) {
        // Ignore collapse errors - not critical
      }
    } else {
      // Use empty/default values if expansion failed
      detailFields = {
        subject: "",
        term: "",
        eligibleGrades: "",
        prerequisite: "",
        corequisite: "",
        enrollmentNotes: "",
        courseDescription: "",
      };
    }

    // Create and validate the course object with school information
    const courseData = createCourse({
      courseCode: cardInfo.courseCode,
      courseName: cardInfo.courseName,
      credits: cardInfo.credits,
      tags: cardInfo.tags,
      schools: [schoolName],
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
 * Normalizes a school name into a filesystem-safe slug
 * Example: "Seven Lakes High School" -> "SevenLakesHighSchool"
 */
function schoolNameToSlug(schoolName: string): string {
  return schoolName.replace(/\s+/g, "").replace(/[^a-zA-Z0-9]/g, "");
}

/**
 * Loads existing courses from the output file if it exists
 * Returns a map of courseCode -> Course and a set of existing course codes
 */
async function loadExistingCourses(
  outputFile: string
): Promise<{ coursesMap: Record<string, Course>; existingCodes: Set<string> }> {
  try {
    const fileContent = await fs.readFile(outputFile, "utf-8");
    const catalog = JSON.parse(fileContent);
    const validated = CourseCatalogSchema.parse(catalog);

    const coursesMap: Record<string, Course> = {};
    const existingCodes = new Set<string>();

    for (const course of validated.courses) {
      coursesMap[course.courseCode] = course;
      existingCodes.add(course.courseCode);
    }

    console.log(`\nLoaded ${validated.courses.length} existing courses from ${outputFile}`);
    return { coursesMap, existingCodes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // File doesn't exist yet - that's fine
      console.log("\nNo existing file found - will create new file");
      return { coursesMap: {}, existingCodes: new Set() };
    }
    // Other errors (parse errors, etc.) - log and continue as if no file exists
    console.warn(`\nWarning: Could not load existing file: ${error instanceof Error ? error.message : String(error)}`);
    console.warn("Will create new file");
    return { coursesMap: {}, existingCodes: new Set() };
  }
}

/**
 * Saves courses to the output file, merging with existing courses
 * Returns the total number of courses after merging
 */
async function saveCourses(
  outputFile: string,
  newCourses: Course[],
  existingCoursesMap: Record<string, Course>,
  schoolName: string
): Promise<number> {
  // Merge new courses with existing courses
  const mergedCoursesMap: Record<string, Course> = { ...existingCoursesMap };

  for (const course of newCourses) {
    if (mergedCoursesMap[course.courseCode]) {
      // Course already exists - merge school names
      const existingCourse = mergedCoursesMap[course.courseCode];
      course.schools.forEach((sch) => {
        if (!existingCourse.schools.includes(sch)) {
          existingCourse.schools.push(sch);
        }
      });
    } else {
      // New course - add it
      mergedCoursesMap[course.courseCode] = course;
    }
  }

  const finalCourses = Object.values(mergedCoursesMap);

  const catalog = {
    source: {
      district: DISTRICT,
      url: TARGET_URL,
    },
    courses: finalCourses,
  };

  const validated = CourseCatalogSchema.parse(catalog);

  await fs.mkdir(OUTPUT_SCHOOLS_DIR, { recursive: true });
  await fs.writeFile(
    outputFile,
    JSON.stringify(validated, null, 2),
    "utf-8"
  );

  return finalCourses.length;
}

/**
 * Main scraper function
 */
async function main(): Promise<void> {
  console.log("SchooLinks Course Catalog Scraper (single school mode)");
  console.log("======================================================\n");

  // CLI args:
  // --school "Exact School Name" (required for scraping)
  // --limit N (optional: limit number of courses for this school)
  // --list-schools (optional: just list schools and exit)
  const args = process.argv.slice(2);
  const limitIndex = args.indexOf("--limit");
  const testLimit = limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : null;

  const schoolArgIndex = args.indexOf("--school");
  const listSchoolsOnly = args.includes("--list-schools");
  const schoolName =
    schoolArgIndex !== -1 ? args[schoolArgIndex + 1] : undefined;

  if (testLimit) {
    console.log(`TEST MODE: Limited to first ${testLimit} courses\n`);
  }

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

    // Get list of available schools (for validation / discovery)
    console.log("\n" + "=".repeat(60));
    console.log("EXTRACTING SCHOOL LIST");
    console.log("=".repeat(60) + "\n");

    const schools = await getAvailableSchools(page);
    console.log(`Found ${schools.length} schools on the site`);
    console.log("Schools:", schools.join(", "));

    if (listSchoolsOnly) {
      console.log("\n--list-schools specified; exiting without scraping.");
      return;
    }

    if (!schoolName) {
      console.error(
        '\nERROR: You must specify a school to scrape using --school "Exact School Name".'
      );
      console.log("\nAvailable schools:");
      for (const s of schools) {
        console.log(`  - ${s}`);
      }
      process.exitCode = 1;
      return;
    }

    if (!schools.includes(schoolName)) {
      console.error(`\nERROR: School "${schoolName}" was not found in the dropdown.`);
      console.log("\nAvailable schools:");
      for (const s of schools) {
        console.log(`  - ${s}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log("\n" + "=".repeat(60));
    console.log(`SCRAPING SCHOOL: ${schoolName}`);
    console.log("=".repeat(60) + "\n");

    // Determine output file path
    await fs.mkdir(OUTPUT_SCHOOLS_DIR, { recursive: true });
    const slug = schoolNameToSlug(schoolName);
    const outputFile = path.join(
      OUTPUT_SCHOOLS_DIR,
      `courses.katyisd.${slug}.json`
    );

    // Load existing courses if file exists
    const { coursesMap: existingCoursesMap, existingCodes } = await loadExistingCourses(outputFile);
    const originalExistingCount = Object.keys(existingCoursesMap).length;

    // Select the school
    await selectSchool(page, schoolName);
    await waitForSchoolFilterUpdate(page);
    
    // #region agent log
    const afterFilterState = await page.evaluate(() => {
      const schoolFilterValue = (document.querySelector('#school-filter') as HTMLInputElement)?.value || '';
      const rowCount = document.querySelectorAll('tr').length;
      const courseRows = Array.from(document.querySelectorAll('tr')).filter(r => {
        const cells = r.querySelectorAll('td');
        if (cells.length < 3) return false;
        const firstCell = cells[0].textContent?.trim() || '';
        // Match both high school format (4 digits: 0020A) and junior high format (J prefix: J0072A)
        return /^(?:[0-9]{4}|J[0-9]+)[A-Z]+/.test(firstCell);
      }).length;
      const bodyText = document.body.textContent || '';
      const hasEmptyState = bodyText.includes('No courses') || bodyText.includes('no courses found');
      return { schoolFilterValue, rowCount, courseRows, hasEmptyState };
    });
    fetch('http://127.0.0.1:7251/ingest/a8ff32ba-c99a-4205-a376-227d419bef9c',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'scrape.ts:454',message:'After filter: state before scroll',data:afterFilterState,timestamp:Date.now(),runId:'debug1',hypothesisId:'D'})}).catch(()=>{});
    // #endregion

    // Scroll to load all courses for this school
    const targetLimit = testLimit ? testLimit * 2 : null;
    await scrollToLoadCourses(page, targetLimit);

    // Get all course info for this school
    const courseInfoList = await findCourseCards(page);
    console.log(`\nFound ${courseInfoList.length} courses on website for ${schoolName}`);

    if (courseInfoList.length === 0) {
      console.warn(`No courses found for ${schoolName}, nothing to save.`);
      return;
    }

    // Filter to only new courses (not in existing file)
    const newCourseInfoList = courseInfoList.filter(
      (cardInfo) => !existingCodes.has(cardInfo.courseCode)
    );

    if (newCourseInfoList.length === 0) {
      console.log(`\n✓ All ${courseInfoList.length} courses already exist in the file. No new courses to scrape.`);
      return;
    }

    console.log(`\nFound ${newCourseInfoList.length} new courses to scrape (${courseInfoList.length - newCourseInfoList.length} already exist)`);

    const coursesToProcess = testLimit
      ? newCourseInfoList.slice(0, testLimit)
      : newCourseInfoList;
    console.log(
      `Processing ${coursesToProcess.length} new courses for ${schoolName}...\n`
    );

    const newCoursesMap: Record<string, Course> = {};
    let successCount = 0;
    let errorCount = 0;
    let coursesSavedCount = 0;

    for (let i = 0; i < coursesToProcess.length; i++) {
      const cardInfo = coursesToProcess[i];

      const courseData = await extractCourseData(
        cardInfo,
        i,
        page,
        schoolName
      );

      if (courseData) {
        if (!courseData.courseCode || !courseData.courseName) {
          console.warn(`Course ${i + 1}: Missing required fields, skipping`);
          errorCount++;
          continue;
        }

        // Merge by courseCode within this school run (should be rare)
        if (newCoursesMap[courseData.courseCode]) {
          const existingCourse = newCoursesMap[courseData.courseCode];
          courseData.schools.forEach((sch) => {
            if (!existingCourse.schools.includes(sch)) {
              existingCourse.schools.push(sch);
            }
          });
        } else {
          newCoursesMap[courseData.courseCode] = courseData;
        }

        successCount++;
      } else {
        errorCount++;
      }

      // Save checkpoint every CHECKPOINT_INTERVAL courses
      const currentNewCourseCount = Object.keys(newCoursesMap).length;
      if (currentNewCourseCount - coursesSavedCount >= CHECKPOINT_INTERVAL) {
        // Save all new courses accumulated so far (merge handles duplicates)
        const newCoursesToSave = Object.values(newCoursesMap);
        const totalCourses = await saveCourses(outputFile, newCoursesToSave, existingCoursesMap, schoolName);
        // Update existingCoursesMap to include all courses we just saved
        newCoursesToSave.forEach(course => {
          if (existingCoursesMap[course.courseCode]) {
            // Merge school names if course already exists
            course.schools.forEach((sch) => {
              if (!existingCoursesMap[course.courseCode].schools.includes(sch)) {
                existingCoursesMap[course.courseCode].schools.push(sch);
              }
            });
          } else {
            existingCoursesMap[course.courseCode] = course;
          }
        });
        coursesSavedCount = currentNewCourseCount;
        console.log(`\n✓ Checkpoint saved: ${newCoursesToSave.length} new courses (${totalCourses} total in file)`);
      }

      if (
        (i + 1) % PROGRESS_LOG_INTERVAL === 0 ||
        i + 1 === coursesToProcess.length
      ) {
        console.log(
          `\nProgress: ${i + 1}/${coursesToProcess.length} (${successCount} successful, ${errorCount} errors)`
        );
      }
    }

    const newCourses = Object.values(newCoursesMap);

    console.log("\n\n" + "=".repeat(60));
    console.log("SCRAPING COMPLETE (single school)");
    console.log("=".repeat(60));
    console.log(`School: ${schoolName}`);
    console.log(`New courses scraped: ${newCourses.length}`);

    if (newCourses.length === 0 && existingCodes.size === 0) {
      console.error(
        "\nWARNING: No courses were extracted for this school. Check the extraction logic."
      );
      return;
    }

    // Final save - merge all new courses with existing
    const totalCourses = await saveCourses(outputFile, newCourses, existingCoursesMap, schoolName);

    console.log(`\nPer-school output saved: ${outputFile}`);
    console.log(`Total courses in file: ${totalCourses} (${originalExistingCount} existing + ${newCourses.length} new)`);

  } catch (error) {
    console.error("\n\nFatal error during scraping:", error);
  } finally {
    await browser.close();
  }
}

// Run the scraper
main().catch((error) => {
  console.error("Scraper failed:", error);
  process.exit(1);
});

