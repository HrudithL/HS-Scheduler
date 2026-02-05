# SchooLinks Course Catalog Scraper

A TypeScript/Playwright-based scraper for extracting course information from the SchooLinks course catalog platform. Specifically configured for Katy ISD course offerings.

## Features

- **Infinite Scroll Handling**: Automatically loads all courses by scrolling to the bottom of the page
- **Robust DOM Extraction**: Uses text-based and role-based locators for stability
- **Checkpointing**: Saves progress every 100 courses and supports resume on failure
- **Error Recovery**: Continues scraping even if individual courses fail
- **Data Validation**: Uses Zod schemas to ensure data quality
- **Retry Logic**: Automatically retries failed operations
- **Progress Logging**: Shows progress every 50 courses

## Installation

### Prerequisites

- Node.js (v18 or higher)
- npm (comes with Node.js)

### Setup

1. Clone or navigate to the project directory:
```bash
cd ScheduleBulider
```

2. Install dependencies:
```bash
npm install
```

3. Install Playwright browsers (Chromium):
```bash
npx playwright install chromium
```

## Usage

### Run the Full Scraper

To scrape all courses from the Katy ISD catalog:

```bash
npm run scrape
```

This will:
- Launch a headless Chromium browser
- Navigate to the SchooLinks course catalog
- Load all courses via infinite scroll
- Extract all course details
- Save results to `output/courses.katy-isd.json`

### Test Mode (Limited Courses)

To test with only the first 10 courses:

```bash
npm run test
```

Or specify a custom limit:

```bash
npm run scrape -- --limit 25
```

## Output

The scraper generates two files in the `output/` directory:

### 1. `courses.katy-isd.json` (Final Output)

Contains an array of course objects with the following structure:

```json
[
  {
    "courseCode": "0103VIRSA",
    "courseName": "Summer English 3 A (Virtual)",
    "credits": 0.5,
    "tags": ["VIR", "$"],
    "subject": "English Language Arts",
    "term": "Semester 1",
    "eligibleGrades": ["9th", "10th", "11th", "12th"],
    "prerequisite": "n/a",
    "corequisite": "n/a",
    "enrollmentNotes": "n/a",
    "courseDescription": "Students will continue to...",
    "source": {
      "district": "katy-isd",
      "url": "https://app.schoolinks.com/course-catalog/katy-isd/course-offerings"
    }
  }
]
```

### 2. `courses.katy-isd.partial.json` (Checkpoint)

- Automatically saved every 100 courses
- Used to resume scraping if the process is interrupted
- Deleted automatically when scraping completes successfully

## How It Works

### 1. Infinite Scroll Detection

The scraper identifies the scrollable container and repeatedly scrolls to the bottom until no new courses are loaded. It considers the page fully loaded after the course count remains stable for 3 consecutive scroll attempts.

### 2. DOM Selector Strategy

The scraper uses multiple fallback strategies to locate course cards:

1. Elements with `course` in their class/id/data-testid
2. Clickable elements (`role="button"`) or card/item elements
3. Divs containing course code patterns (e.g., `0103VIRSA`)

For field extraction, it uses **text-based locators** to find labels like:
- `Subject:`
- `Term:`
- `Eligible grades:`
- `Prerequisite:`
- `Corequisite:`
- `Enrollment notes:`
- `Course description:`

This approach is more stable than CSS class selectors, which are often auto-generated.

### 3. Error Handling

- **Per-Course Errors**: If a single course fails to extract, the error is logged and the scraper continues
- **Retry Logic**: Failed expand/collapse operations are retried up to 2 times with exponential backoff
- **Checkpointing**: Every 100 courses, progress is saved to a checkpoint file
- **Resume Support**: On restart, the scraper checks for a checkpoint and skips already-processed courses

### 4. Data Normalization

All extracted data is normalized before validation:

- **N/A Values**: Empty strings, "N/A", "n/a", and "-" are normalized to `"n/a"`
- **Credits**: Extracted as numbers from strings like "0.5" or "0.5 credits"
- **Grades**: Comma-separated strings like "9th, 10th, 11th, 12th" are split into arrays
- **Descriptions**: Unicode is normalized and replacement characters are removed

### 5. Validation

Every course object is validated against a Zod schema before being added to the output. Invalid courses are rejected and logged as errors.

## Troubleshooting

### No Courses Found

If the scraper reports "No course cards found":

1. Check that the URL is correct and accessible
2. A debug screenshot (`debug-no-courses.png`) will be saved
3. The DOM selectors may need updating if the site structure has changed

### Courses Missing Fields

Some fields may be optional on the SchooLinks platform. Missing fields will be normalized to `"n/a"`.

### Scraper Crashes or Hangs

- **Resume from Checkpoint**: Simply run `npm run scrape` again. It will load the checkpoint and continue
- **Infinite Scroll Issues**: If the page never stops loading, try adjusting `MAX_SCROLL_ATTEMPTS` in `src/scrape.ts`
- **Timeout Errors**: Increase the timeout values in `src/dom.ts` for slow connections

### Rate Limiting or Blocking

The scraper uses:
- Realistic wait times between actions
- A real browser (not just HTTP requests)
- Standard user agent headers

If you encounter rate limiting, add delays between course processing in `src/scrape.ts`.

## Customization

### Scrape a Different District

1. Change the `TARGET_URL` in `src/scrape.ts`
2. Update the `DISTRICT` constant
3. Update output filenames accordingly

### Adjust Intervals

In `src/scrape.ts`, you can modify:
- `CHECKPOINT_INTERVAL`: How often to save progress (default: 100)
- `PROGRESS_LOG_INTERVAL`: How often to log progress (default: 50)
- `MAX_SCROLL_ATTEMPTS`: When to stop scrolling (default: 3)

### Add New Fields

1. Add the field to the Zod schema in `src/schema.ts`
2. Add extraction logic in `src/dom.ts` (in `extractDetailFields`)
3. Update the `createCourse` function call in `src/scrape.ts`

## Project Structure

```
ScheduleBulider/
├── package.json          # Dependencies and scripts
├── tsconfig.json         # TypeScript configuration
├── README.md             # This file
├── src/
│   ├── scrape.ts        # Main scraper orchestration
│   ├── schema.ts        # Zod schemas and normalization
│   └── dom.ts           # DOM extraction helpers
└── output/
    ├── courses.katy-isd.json          # Final output
    └── courses.katy-isd.partial.json  # Checkpoint (temp)
```

## Dependencies

- **playwright**: Browser automation
- **zod**: Schema validation
- **p-limit**: Concurrency control (currently unused, reserved for future parallel processing)
- **typescript**: Type safety
- **ts-node**: TypeScript execution

## Future Enhancements

- Network interception mode to extract data directly from API calls
- Parallel processing of course detail extraction
- Progress bar visualization
- Support for multiple districts in a single run
- Export to CSV/Excel formats

## License

MIT

## Author

Created for Katy ISD course catalog extraction.

