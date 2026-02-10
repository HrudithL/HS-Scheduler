import { Page, Locator, ElementHandle } from "playwright";

/**
 * Finds the scrollable container element on the page
 * Returns the element that has the course list and can be scrolled
 */
export async function findScrollContainer(page: Page): Promise<ElementHandle> {
  // Try to find a scrollable container with overflow properties
  const scrollableElements = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("*"));
    const scrollable = elements.filter((el) => {
      const style = window.getComputedStyle(el);
      const overflow = style.overflow + style.overflowY;
      const hasScroll = overflow.includes("auto") || overflow.includes("scroll");
      const hasHeight = el.scrollHeight > el.clientHeight;
      return hasScroll && hasHeight && el.scrollHeight > 500; // Minimum height threshold
    });
    
    // Return the scrollable element with the largest scrollHeight
    if (scrollable.length > 0) {
      const sorted = scrollable.sort((a, b) => b.scrollHeight - a.scrollHeight);
      // Store a unique identifier
      (sorted[0] as any).__scrollContainer = true;
      return true;
    }
    return false;
  });

  if (scrollableElements) {
    const container = await page.evaluateHandle(() => {
      const elements = Array.from(document.querySelectorAll("*"));
      return elements.find((el) => (el as any).__scrollContainer);
    });
    return container.asElement()!;
  }

  // Fallback: return the body element
  console.warn("Could not find scroll container, using document.body");
  return (await page.$("body"))!;
}

/**
 * Course info extracted from the DOM with stable identifiers
 */
export interface CourseCardInfo {
  courseCode: string;
  courseName: string;
  credits: string;
  tags: string[];
}

/**
 * Finds all course cards and extracts their info in a single pass.
 * Returns course info array instead of Locators to avoid DOM mutation issues.
 */
export async function findCourseCards(page: Page): Promise<CourseCardInfo[]> {
  
  // Extract all course data directly from the DOM in one pass
  // This avoids the Locator index shifting problem when cards are expanded
  const courseData = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const courses: {courseCode: string; courseName: string; credits: string; tags: string[]}[] = [];
    const seenCodes = new Set<string>();
    
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 3) continue;
      
      const firstCellText = cells[0].textContent?.trim() || '';
      // Match both high school format (4 digits: 0020A) and junior high format (J prefix: J0072A)
      const codeMatch = firstCellText.match(/^((?:[0-9]{4}|J[0-9]+)[A-Z]+[0-9]*)\b/);
      if (!codeMatch) continue;
      
      const courseCode = codeMatch[1];
      if (seenCodes.has(courseCode)) continue;
      
      const secondCellText = cells[1].textContent?.trim() || '';
      // Skip detail rows
      if (secondCellText.includes("Subject:") || secondCellText.includes("Term:")) continue;
      
      const courseName = secondCellText;
      const creditsText = cells[2].textContent?.trim() || '0';
      const creditsMatch = creditsText.match(/(\d+\.?\d*)/);
      const credits = creditsMatch ? creditsMatch[1] : '0';
      
      // Extract tags from remaining cells
      // Tags are in nested div elements, so we need to extract each div separately
      const tags: string[] = [];
      
      // Helper function to map full-text descriptions to tag abbreviations
      const mapTextToTag = (text: string): string | null => {
        const upperText = text.toUpperCase().trim();
        // Map common full-text descriptions to abbreviations
        if (upperText.includes('ADVANCED PLACEMENT') || upperText === 'ADVANCED PLACEMENT') return 'AP';
        if (upperText === 'VIRTUAL' || (upperText.includes('VIRTUAL') && !upperText.match(/^[A-Z]{1,4}$/))) return 'VIR';
        if (upperText.includes('DUAL CREDIT') || upperText === 'DUAL CREDIT') return 'DC';
        if (upperText.includes('COURSE FEE REQUIRED') || upperText === 'COURSE FEE REQUIRED') return '$';
        if (upperText.includes('KAP') || upperText === 'KAP') return 'KAP';
        return null;
      };
      
      // Helper function to split concatenated tag strings (e.g., "CTEJHJHHS" -> ["CTE", "JH", "JH", "HS"])
      const splitConcatenatedTags = (text: string): string[] => {
        if (!text || text.length === 0) return [];
        const upperText = text.toUpperCase();
        
        // Common tag patterns (2-4 uppercase letters)
        const commonTags = ['KAP', 'AP', 'DC', 'VIR', 'CTE', 'JH', 'HS', 'MS', 'ES', 'IB', 'GT', 'ESL', 'SPED'];
        const foundTags: string[] = [];
        let remaining = upperText;
        
        // Try to match common tags first (longest first to avoid partial matches)
        const sortedTags = commonTags.sort((a, b) => b.length - a.length);
        for (const tag of sortedTags) {
          while (remaining.includes(tag)) {
            const index = remaining.indexOf(tag);
            foundTags.push(tag);
            remaining = remaining.substring(0, index) + remaining.substring(index + tag.length);
          }
        }
        
        // Also extract any remaining 1-4 uppercase letter sequences
        const remainingTags = remaining.match(/[A-Z]{1,4}/g) || [];
        foundTags.push(...remainingTags);
        
        return foundTags.filter(t => t.length > 0);
      };
      
      for (let i = 3; i < cells.length; i++) {
        const cell = cells[i];
        
        // Strategy 1: Extract from nested div elements (most reliable for structured tags)
        // Look for any divs that are direct children of the cell or nested deeper
        const allDivs = cell.querySelectorAll('div');
        const tagDivs: HTMLElement[] = [];
        const processedTexts = new Set<string>();
        
        // Find divs that contain tag-like content (not empty, not too long, likely a tag)
        for (const div of Array.from(allDivs)) {
          const divText = (div.textContent || '').trim();
          if (!divText || divText.length > 50) continue; // Skip empty or very long text (likely descriptions)
          
          // Skip if we've already processed this exact text (avoid duplicates from nested divs)
          if (processedTexts.has(divText)) continue;
          
          // Check if this div looks like it contains a tag (short text, or matches tag patterns)
          const upperDivText = divText.toUpperCase();
          const isLikelyTag = divText.length <= 25 && (
            divText.match(/^[A-Z]{1,4}$/) || 
            divText === "$" || 
            divText === "★" || 
            divText === "⭐" ||
            upperDivText.includes('ADVANCED PLACEMENT') ||
            upperDivText.includes('VIRTUAL') ||
            upperDivText.includes('DUAL CREDIT') ||
            upperDivText.includes('COURSE FEE REQUIRED') ||
            upperDivText === 'KAP' ||
            upperDivText.includes('KAP')
          );
          
          if (isLikelyTag) {
            // Check if this div is a leaf (no child divs with text) or has minimal nesting
            // We want the innermost div that contains the tag text
            const childDivsWithText = Array.from(div.querySelectorAll('div')).filter(d => {
              const childText = (d.textContent || '').trim();
              return childText.length > 0 && childText !== divText;
            });
            
            // If no children with different text, or if this div's text is different from children, use it
            if (childDivsWithText.length === 0) {
              tagDivs.push(div);
              processedTexts.add(divText);
            } else {
              // Check if any child has the same text (then use the child instead)
              const hasSameTextChild = childDivsWithText.some(d => (d.textContent || '').trim() === divText);
              if (!hasSameTextChild) {
                tagDivs.push(div);
                processedTexts.add(divText);
              }
            }
          }
        }
        
        // Extract tags from the identified divs
        for (const div of tagDivs) {
          const divText = (div.textContent || '').trim();
          if (!divText) continue;
          
          // Check if it's a mapped full-text description
          const mappedTag = mapTextToTag(divText);
          if (mappedTag && !tags.includes(mappedTag)) {
            tags.push(mappedTag);
            continue;
          }
          
          // Check if it's a standard 1-4 uppercase letter tag
          if (divText.match(/^[A-Z]{1,4}$/) || divText === "$" || divText === "★" || divText === "⭐") {
            if (!tags.includes(divText)) {
              tags.push(divText);
            }
          }
        }
        
        // If we found tags from divs, skip the fallback text extraction
        if (tagDivs.length > 0) {
          continue;
        }
        
        // Strategy 2: Fallback - extract from cell textContent (for cases without nested divs)
        const cellText = cell.textContent?.trim() || '';
        if (cellText && tagDivs.length === 0) {
          // Check if it's a concatenated tag string (all uppercase, no spaces)
          if (cellText.match(/^[A-Z]{4,}$/) && !cellText.includes(' ')) {
            const splitTags = splitConcatenatedTags(cellText);
            for (const tag of splitTags) {
              if (!tags.includes(tag)) {
                tags.push(tag);
              }
            }
            continue;
          }
          
          // Check for mapped full-text descriptions
          const mappedTag = mapTextToTag(cellText);
          if (mappedTag && !tags.includes(mappedTag)) {
            tags.push(mappedTag);
          }
          
          // Check for multiple phrases that might map to tags
          if (cellText.includes('Course Fee Required') && !tags.includes('$')) {
            tags.push('$');
          }
          if (cellText.includes('Virtual') && !tags.includes('VIR')) {
            tags.push('VIR');
          }
          if (cellText.includes('Advanced Placement') && !tags.includes('AP')) {
            tags.push('AP');
          }
          if (cellText.includes('Dual Credit') && !tags.includes('DC')) {
            tags.push('DC');
          }
          
          // Standard extraction - split by whitespace and filter
          const cellTags = cellText.split(/\s+/).filter((t: string) => 
            t.length > 0 && t.length <= 4 && (t.match(/^[A-Z]{1,4}$/) || t === "$" || t === "★" || t === "⭐")
          );
          for (const tag of cellTags) {
            if (!tags.includes(tag)) {
              tags.push(tag);
            }
          }
        }
      }
      
      seenCodes.add(courseCode);
      courses.push({ courseCode, courseName, credits, tags });
    }
    
    return courses;
  });
  
  return courseData;
}

/**
 * Finds a specific course row by its course code (for expansion)
 */
export async function findCourseRowByCode(page: Page, courseCode: string): Promise<Locator | null> {
  
  // Find the row using DOM evaluation (Playwright's :has() selector doesn't work reliably)
  // Mark the row with a temporary data attribute, then use a selector to find it
  const found = await page.evaluate((searchCode) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    for (const row of rows) {
      const firstCell = row.querySelector('td:first-child');
      if (firstCell) {
        const text = firstCell.textContent?.trim() || '';
        // Match both high school format (4 digits: 0020A) and junior high format (J prefix: J0072A)
        const codeMatch = text.match(/^((?:[0-9]{4}|J[0-9]+)[A-Z]+[0-9]*)\b/);
        if (codeMatch && codeMatch[1] === searchCode) {
          // Mark the row with a temporary attribute
          (row as HTMLElement).setAttribute('data-course-code-target', searchCode);
          return true;
        }
      }
    }
    return false;
  }, courseCode);
  
  if (!found) {
    return null;
  }
  
  // Use the data attribute to find the row
  const row = page.locator(`tr[data-course-code-target="${courseCode}"]`);
  
  return row;
}

/**
 * Extracts the course code from a card element
 */
export async function extractCourseCode(card: Locator): Promise<string> {
  try {
    // Look for text that matches course code pattern (e.g., "0103VIRSA" or "J0072A")
    const text = await card.innerText();
    // Match both high school format (4 digits: 0020A) and junior high format (J prefix: J0072A)
    const match = text.match(/\b(?:[0-9]{4}|J[0-9]+)[A-Z]+[0-9]*\b/);
    return match ? match[0] : "";
  } catch (error) {
    return "";
  }
}

/**
 * Extracts header fields from a course card (before expansion)
 * Table row structure: courseCode \t courseName \t credits \t tags
 */
export async function extractHeaderFields(card: Locator): Promise<{
  courseCode: string;
  courseName: string;
  credits: string;
  tags: string[];
}> {
  try {
    // First, try to extract from table cells (td elements) - most reliable
    try {
      const cells = await card.locator('td').all();
      if (cells.length >= 3) {
        const courseCode = (await cells[0].innerText()).trim();
        const courseName = (await cells[1].innerText()).trim();
        const creditsText = (await cells[2].innerText()).trim();
        // Extract numeric value from credits (handle cases like "0.5 credits")
        const creditsMatch = creditsText.match(/(\d+\.?\d*)/);
        const credits = creditsMatch ? creditsMatch[1] : "0";
        
        // Extract tags from remaining cells (usually 4th cell onwards)
        const tags: string[] = [];
        for (let i = 3; i < cells.length; i++) {
          const cellText = (await cells[i].innerText()).trim();
          // Split by whitespace and filter for tags
          const cellTags = cellText.split(/\s+/).filter(t => 
            t.length > 0 && (t.match(/^[A-Z]{1,4}$/) || t === "$" || t === "★" || t === "⭐")
          );
          tags.push(...cellTags);
        }
        
        
        // Match both high school format (4 digits: 0020A) and junior high format (J prefix: J0072A)
        if (courseCode && courseCode.match(/^(?:[0-9]{4}|J[0-9]+)[A-Z]+/)) {
          return { courseCode, courseName, credits, tags };
        }
      }
    } catch (error) {
      // Fall through to text parsing
    }
    
    // Fallback: parse from text content
    const text = await card.innerText();
    
    // Skip if this is expanded content (has detail fields)
    if (text.includes("Subject:") || text.includes("Term:") || text.includes("Eligible grades:")) {
      // Try to find the parent row and extract from its first cells
      try {
        const row = card.locator('..').first(); // Go up to parent tr
        const cells = await row.locator('td').all();
        if (cells.length >= 3) {
          const courseCode = (await cells[0].innerText()).trim();
          const courseName = (await cells[1].innerText()).trim();
          const creditsText = (await cells[2].innerText()).trim();
          const creditsMatch = creditsText.match(/(\d+\.?\d*)/);
          const credits = creditsMatch ? creditsMatch[1] : "0";
          
          const tags: string[] = [];
          for (let i = 3; i < cells.length; i++) {
            const cellText = (await cells[i].innerText()).trim();
            const cellTags = cellText.split(/\s+/).filter(t => 
              t.length > 0 && (t.match(/^[A-Z]{1,4}$/) || t === "$" || t === "★" || t === "⭐")
            );
            tags.push(...cellTags);
          }
          
          // Match both high school format (4 digits: 0020A) and junior high format (J prefix: J0072A)
          if (courseCode && courseCode.match(/^(?:[0-9]{4}|J[0-9]+)[A-Z]+/)) {
            return { courseCode, courseName, credits, tags };
          }
        }
      } catch (error) {
        // Continue to text parsing
      }
    }
    
    // Parse table row structure from text: split by tabs and newlines
    // Format: "0020A\n\tStudy Hall\t\n0\n\t\t" or "0065VIRF\n\tLEADWORTHY\t\n0.5\n\t\nVIR\n$\n\t"
    const parts = text.split(/\t|\n/).map(p => p.trim()).filter(p => p.length > 0);
    
    let courseCode = "";
    let courseName = "";
    let credits = "0";
    const tags: string[] = [];
    
    // Find course code first
    // Match both high school format (4 digits: 0020A) and junior high format (J prefix: J0072A)
    for (const part of parts) {
      if (part.match(/^(?:[0-9]{4}|J[0-9]+)[A-Z]+[0-9]*$/)) {
        courseCode = part;
        break;
      }
    }
    
    if (!courseCode) {
      // Try regex match on full text
      // Match both high school format (4 digits: 0020A) and junior high format (J prefix: J0072A)
      const codeMatch = text.match(/\b((?:[0-9]{4}|J[0-9]+)[A-Z]+[0-9]*)\b/);
      if (codeMatch) {
        courseCode = codeMatch[1];
      }
    }
    
    if (courseCode) {
      // Extract course name: look for text between course code and credits
      const codeIndex = text.indexOf(courseCode);
      const afterCode = text.substring(codeIndex + courseCode.length);
      // Pattern: \t CourseName \t Credits
      const nameMatch = afterCode.match(/\t+([^\t\n]+?)\t+\s*(\d+\.?\d*)/);
      if (nameMatch) {
        courseName = nameMatch[1].trim();
        credits = nameMatch[2];
      } else {
        // Try simpler pattern
        const simpleMatch = afterCode.match(/\t+([^\t\n]+)/);
        if (simpleMatch) {
          courseName = simpleMatch[1].trim();
        }
      }
      
      // Extract credits if not found yet
      if (credits === "0") {
        const creditMatch = text.match(/\t+\d+\.?\d*\s*\t/);
        if (creditMatch) {
          const creditValue = creditMatch[0].match(/(\d+\.?\d*)/);
          if (creditValue) {
            credits = creditValue[1];
          }
        }
      }
      
      // Extract tags: look for short uppercase tokens after credits
      const tagMatches = text.match(/\b([A-Z]{1,4})\b|\$|★|⭐/g);
      if (tagMatches) {
        for (const tag of tagMatches) {
          if (tag !== courseCode && tag !== courseCode.substring(0, 4) && 
              tag.length <= 4 && !tags.includes(tag)) {
            tags.push(tag);
          }
        }
      }
    }
    
    return { courseCode, courseName, credits, tags };
  } catch (error) {
    console.error("Error extracting header fields:", error);
    return { courseCode: "", courseName: "", credits: "0", tags: [] };
  }
}

/**
 * Expands a course card to show details
 */
export async function expandCourseCard(card: Locator, page: Page): Promise<void> {
  try {
    // Check if already expanded by looking for detail fields
    const cardText = await card.innerText();
    const isExpanded = cardText.includes("Subject:") || cardText.includes("Term:");
    
    if (isExpanded) {
      return;
    }
    
    // Try multiple click strategies - cells have role="button" so they're clickable
    let clicked = false;
    
    // Strategy 1: Click the first cell (which has role="button" and tabindex="0")
    try {
      const firstCell = card.locator('td').first();
      await firstCell.click({ timeout: 3000 });
      clicked = true;
    } catch (error) {
      // Continue to next strategy
    }
    
    // Strategy 2: Use JavaScript to click the first cell (triggers React events)
    if (!clicked) {
      try {
        await card.evaluate((row) => {
          const firstCell = row.querySelector('td[role="button"]') || row.querySelector('td:first-child');
          if (firstCell) {
            // Try multiple event types
            const events = ['click', 'mousedown', 'mouseup'];
            events.forEach(eventType => {
              const event = new MouseEvent(eventType, {
                bubbles: true,
                cancelable: true,
                view: window,
                button: 0
              });
              firstCell.dispatchEvent(event);
            });
            // Also try calling click() directly if it exists
            if (typeof (firstCell as HTMLElement).click === 'function') {
              (firstCell as HTMLElement).click();
            }
          }
        });
        clicked = true;
      } catch (error) {
        // Continue to fallback
      }
    }
    
    // Strategy 3: Fallback - click the row itself
    if (!clicked) {
      await card.click({ timeout: 3000 });
    }
    
    // Wait for detail fields to actually appear (not just a timeout)
    // Check for "Subject:" text which indicates expansion
    // Also check for hidden elements or async loading
    let expanded = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      await page.waitForTimeout(300 + (attempt * 150)); // 300ms, 450ms, 600ms, 750ms, 900ms, 1050ms, 1200ms, 1350ms
      
      // Check multiple ways: innerText, textContent, and hidden elements
      const cardTextAfter = await card.innerText();
      const hasSubjectInText = cardTextAfter.includes("Subject:");
      
      // Also check if there are any hidden detail rows or elements
      const hiddenDetails = await card.evaluate((row) => {
        // Check for hidden detail rows (common pattern)
        const allRows = Array.from(row.parentElement?.querySelectorAll('tr') || []);
        // Find index by comparing elements
        let rowIndex = -1;
        for (let i = 0; i < allRows.length; i++) {
          if (allRows[i] === row) {
            rowIndex = i;
            break;
          }
        }
        const nextRows = allRows.slice(rowIndex + 1);
        
        // Look for a detail row (usually has Subject: text)
        for (const nextRow of nextRows) {
          const text = (nextRow as HTMLElement).innerText || nextRow.textContent || '';
          if (text.includes('Subject:') || text.includes('Term:')) {
            // Check if it's visible
            const style = window.getComputedStyle(nextRow as HTMLElement);
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
            return {
              found: true,
              visible: isVisible,
              text: text.substring(0, 300),
              className: (nextRow as HTMLElement).className
            };
          }
          // Stop at next course row (has course code pattern)
          if (text.match(/^[0-9]{4}[A-Z]+/)) {
            break;
          }
        }
        return { found: false };
      });
      
      if (hasSubjectInText || (hiddenDetails.found && hiddenDetails.visible)) {
        expanded = true;
        break;
      }
    }
    
    if (!expanded) {
      // Try one more time with a longer wait and check DOM structure
      await page.waitForTimeout(500);
      const finalCheck = await card.evaluate((row) => {
        const allText = (row as HTMLElement).innerText || row.textContent || '';
        const hasSubject = allText.includes('Subject:');
        const nextRow = row.nextElementSibling;
        return {
          hasSubject,
          hasNextRow: !!nextRow,
          nextRowTag: nextRow?.tagName,
          nextRowText: nextRow ? ((nextRow as HTMLElement).innerText || nextRow.textContent || '').substring(0, 200) : '',
          rowHTML: row.outerHTML.substring(0, 500)
        };
      });
      
      if (!finalCheck.hasSubject) {
        // Check if details are in a sibling row (common pattern for expandable tables)
        if (finalCheck.hasNextRow && finalCheck.nextRowText.includes('Subject:')) {
          expanded = true; // Details are in next row, which is fine
        } else {
          throw new Error("Card did not expand - Subject: field not found after click");
        }
      } else {
        expanded = true;
      }
    }
  } catch (error) {
    console.error("Error expanding course card:", error);
    throw error;
  }
}

/**
 * Collapses a course card
 */
export async function collapseCourseCard(card: Locator, page: Page): Promise<void> {
  try {
    const ariaExpanded = await card.getAttribute("aria-expanded");
    if (ariaExpanded === "false" || ariaExpanded === null) {
      return;
    }
    
    // Click again to collapse
    await card.click({ timeout: 3000 });
    await page.waitForTimeout(100);
  } catch (error) {
    // Ignore collapse errors - not critical
    console.warn("Could not collapse course card:", error);
  }
}

/**
 * Extracts a field value by finding the label and reading adjacent text
 */
async function extractFieldByLabel(
  container: Locator,
  label: string
): Promise<string> {
  try {
    // Try to find the label and get the value
    const labelLocator = container.getByText(label, { exact: false });
    const labelExists = await labelLocator.count();
    
    if (labelExists === 0) {
      return "";
    }
    
    // Strategy 1: Get the parent element that contains both label and value
    try {
      const parent = labelLocator.locator("..").first();
      const fullText = await parent.innerText();
      
      // Remove the label to get just the value
      // Handle both "Label:" and "Label: " patterns
      const value = fullText.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').trim();
      
      return value;
    } catch (error) {
      // Strategy 2: Try getting the next sibling element
      try {
        const nextSibling = labelLocator.locator("..").locator("+ *").first();
        const value = await nextSibling.innerText();
        return value.trim();
      } catch (siblingError) {
        // Strategy 3: Parse from container's full text
        const containerText = await container.innerText();
        const labelIndex = containerText.indexOf(label);
        if (labelIndex !== -1) {
          const afterLabel = containerText.substring(labelIndex + label.length);
          // Extract value until next label or end
          const nextLabelMatch = afterLabel.match(/^[:\s]*([\s\S]+?)(?=\n\s*\*\*|$)/);
          const value = nextLabelMatch ? nextLabelMatch[1].trim() : afterLabel.trim();
          return value;
        }
        throw siblingError;
      }
    }
  } catch (error) {
    return "";
  }
}

/**
 * Extracts all detail fields from an expanded course card
 */
export async function extractDetailFields(
  card: Locator,
  page: Page
): Promise<{
  subject: string;
  term: string;
  eligibleGrades: string;
  prerequisite: string;
  corequisite: string;
  enrollmentNotes: string;
  courseDescription: string;
}> {
  try {
    // Check if card is expanded by looking for Subject: text
    const cardText = await card.innerText();
    const isExpanded = cardText.includes("Subject:") || cardText.includes("Term:");
    
    // Check if details are in a sibling row
    let siblingRow: Locator | null = null;
    try {
      const hasSiblingWithDetails = await card.evaluate((row) => {
        const nextRow = row.nextElementSibling;
        if (nextRow && (nextRow.textContent || '').includes('Subject:')) {
          return true;
        }
        return false;
      });
      
      if (hasSiblingWithDetails) {
        // Get the sibling row using XPath
        siblingRow = page.locator(`xpath=//tr[preceding-sibling::tr[1][.//text()[contains(., '${(await card.locator('td').first().innerText()).trim()}')]]]`).first();
        const siblingCount = await siblingRow.count();
        if (siblingCount === 0) {
          siblingRow = null;
        }
      }
    } catch (error) {
      // Continue with just the card
    }
    
    // Additional wait for content to stabilize
    await page.waitForTimeout(200);
    
    // Helper function to extract from card or sibling
    const extractFromCardOrSibling = async (label: string): Promise<string> => {
      // Try card first
      let value = await extractFieldByLabel(card, label);
      // If not found and sibling exists, try sibling
      if (!value && siblingRow) {
        value = await extractFieldByLabel(siblingRow, label);
      }
      return value;
    };
    
    // Extract each field by its label
    const subject = await extractFromCardOrSibling("Subject:");
    const term = await extractFromCardOrSibling("Term:");
    const eligibleGrades = await extractFromCardOrSibling("Eligible grades:");
    const prerequisite = await extractFromCardOrSibling("Prerequisite:");
    const corequisite = await extractFromCardOrSibling("Corequisite:");
    const enrollmentNotes = await extractFromCardOrSibling("Enrollment notes:");
    const courseDescription = await extractFromCardOrSibling("Course description:");
    
    return {
      subject,
      term,
      eligibleGrades,
      prerequisite,
      corequisite,
      enrollmentNotes,
      courseDescription,
    };
  } catch (error) {
    console.error("Error extracting detail fields:", error);
    return {
      subject: "",
      term: "",
      eligibleGrades: "",
      prerequisite: "",
      corequisite: "",
      enrollmentNotes: "",
      courseDescription: "",
    };
  }
}

/**
 * Retries an operation with exponential backoff
 */
export async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 2,
  baseDelay: number = 500
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError || new Error("Operation failed after retries");
}

/**
 * Gets the list of available schools from the school filter dropdown
 */
export async function getAvailableSchools(page: Page): Promise<string[]> {
  try {
    // Use the specific school-filter ID
    const schoolInput = page.locator('#school-filter');
    const inputCount = await schoolInput.count();
    
    if (inputCount === 0) {
      return [];
    }

    // Find all "Open" buttons and identify which belongs to school-filter
    // (There are multiple dropdowns: school-level-filter and school-filter)
    const buttonInfo = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button[aria-label="Open"]'));
      return buttons.map((btn, idx) => {
        const parent = btn.closest('[data-testid="select-container"], .MuiAutocomplete-root, .MuiFormControl-root');
        const input = parent?.querySelector('input');
        return {
          index: idx,
          inputId: input?.id || null,
        };
      });
    });
    
    // Find the button index that corresponds to school-filter input (not school-level-filter)
    const schoolFilterButtonIndex = buttonInfo.findIndex(b => b.inputId === 'school-filter');
    
    // Click the specific button for school-filter input
    try {
      if (schoolFilterButtonIndex >= 0) {
        const allOpenButtons = page.locator('button[aria-label="Open"]');
        const correctButton = allOpenButtons.nth(schoolFilterButtonIndex);
        await correctButton.click({ timeout: 5000 });
      } else {
        // Fallback: click the input directly
        await schoolInput.click({ timeout: 5000 });
      }
    } catch (error) {
      return [];
    }
    
    await page.waitForTimeout(500);

    // Wait for the specific school-filter-listbox (not school-level-filter-listbox)
    let listbox = null;
    try {
      // Wait specifically for school-filter-listbox
      listbox = page.locator('#school-filter-listbox').first();
      await listbox.waitFor({ timeout: 5000, state: 'visible' });
    } catch (error) {
      // Try to find listbox by checking all listboxes and finding the one that's not school-level
      const allListboxes = page.locator('[role="listbox"]');
      const count = await allListboxes.count();
      for (let i = 0; i < count; i++) {
        const candidate = allListboxes.nth(i);
        const id = await candidate.getAttribute('id');
        if (id && id.includes('school-filter') && !id.includes('school-level')) {
          listbox = candidate;
          break;
        }
      }
      
      if (!listbox) {
        return [];
      }
    }

    await page.waitForTimeout(300); // Additional wait for options to render

    // Extract all option texts from the school-filter-listbox
    const schools = await page.evaluate(() => {
      // Find the school-filter-listbox specifically (not school-level-filter-listbox)
      let listbox: Element | null = document.querySelector('#school-filter-listbox');
      
      // Fallback: find any listbox that's not the school-level-filter-listbox
      if (!listbox) {
        const allListboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
        listbox = allListboxes.find(lb => {
          const id = lb.id;
          return id && id.includes('school-filter') && !id.includes('school-level');
        }) || null;
      }

      if (!listbox) return [];

      // Try multiple selectors for options
      const optionSelectors = [
        '[role="option"]',
        'li[role="option"]',
        'li',
        'div[role="option"]'
      ];

      let options: Element[] = [];
      for (const selector of optionSelectors) {
        options = Array.from(listbox.querySelectorAll(selector));
        if (options.length > 0) break;
      }

      const allTexts = options.map(opt => (opt.textContent || '').trim());
      const filtered = allTexts.filter(text => {
        // Filter out empty strings and generic options
        return text.length > 0 && 
               text !== 'All Schools' && 
               text !== 'All' &&
               text !== 'District-wide' &&
               text !== 'High school' &&
               text !== 'Middle school';
      });

      return filtered;
    });

    // Close the dropdown
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } catch (error) {
      // Try clicking outside
      try {
        await page.click('body', { position: { x: 0, y: 0 } });
        await page.waitForTimeout(200);
      } catch (error2) {
        // Ignore
      }
    }

    return schools;
  } catch (error) {
    console.error("Error getting available schools:", error);
    return [];
  }
}

/**
 * Selects a school from the school filter dropdown
 */
export async function selectSchool(page: Page, schoolName: string): Promise<void> {
  try {
    // Use the specific school-filter ID
    const schoolInput = page.locator('#school-filter');
    const inputCount = await schoolInput.count();
    
    if (inputCount === 0) {
      throw new Error('School filter input not found');
    }

    // Find all "Open" buttons and identify which belongs to school-filter
    const buttonInfo = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button[aria-label="Open"]'));
      return buttons.map((btn, idx) => {
        const parent = btn.closest('[data-testid="select-container"], .MuiAutocomplete-root, .MuiFormControl-root');
        const input = parent?.querySelector('input');
        return {
          index: idx,
          inputId: input?.id || null,
        };
      });
    });
    
    // Find the button index that corresponds to school-filter input
    const schoolFilterButtonIndex = buttonInfo.findIndex(b => b.inputId === 'school-filter');
    
    // Click the specific button for school-filter input
    if (schoolFilterButtonIndex >= 0) {
      const allOpenButtons = page.locator('button[aria-label="Open"]');
      const correctButton = allOpenButtons.nth(schoolFilterButtonIndex);
      await correctButton.click({ timeout: 5000 });
    } else {
      // Fallback: click the input directly
      await schoolInput.click({ timeout: 5000 });
    }
    
    await page.waitForTimeout(500);

    // Wait for the specific school-filter-listbox
    const listbox = page.locator('#school-filter-listbox').first();
    try {
      await listbox.waitFor({ timeout: 5000, state: 'visible' });
    } catch (error) {
      throw new Error('School filter listbox did not appear');
    }

    await page.waitForTimeout(300);

    // Find and click the option matching the school name
    // Try multiple selectors for the option
    const optionSelectors = [
      `[role="option"]:has-text("${schoolName}")`,
      `li[role="option"]:has-text("${schoolName}")`,
      `li:has-text("${schoolName}")`,
      `div[role="option"]:has-text("${schoolName}")`
    ];

    let option = null;
    for (const selector of optionSelectors) {
      const candidate = page.locator(selector).first();
      if (await candidate.count() > 0) {
        option = candidate;
        break;
      }
    }

    // If not found with :has-text, try exact text match by iterating
    if (!option || await option.count() === 0) {
      const allOptions = page.locator('[role="option"], li[role="option"], li, div[role="option"]');
      const optionCount = await allOptions.count();
      
      for (let i = 0; i < optionCount; i++) {
        const opt = allOptions.nth(i);
        const text = await opt.textContent();
        if (text && text.trim() === schoolName) {
          await opt.click({ timeout: 5000 });
          await page.waitForTimeout(300);
          return;
        }
      }
      
      throw new Error(`School "${schoolName}" not found in dropdown options`);
    }

    await option.click({ timeout: 5000 });
    await page.waitForTimeout(300);
  } catch (error) {
    console.error(`Error selecting school "${schoolName}":`, error);
    throw error;
  }
}

/**
 * Waits for the course list to update after selecting a school filter
 */
export async function waitForSchoolFilterUpdate(page: Page): Promise<void> {
  try {
    // Wait for the course list to update - this could be:
    // 1. A loading indicator to disappear
    // 2. Course rows to change/update
    // 3. A specific element that indicates filtering is complete
    
    // Wait a bit for the filter to apply
    await page.waitForTimeout(1000);

    // Wait for any loading indicators to disappear
    try {
      await page.waitForSelector('[role="progressbar"], [class*="loading"], [class*="spinner"]', { 
        state: 'hidden', 
        timeout: 5000 
      });
    } catch (error) {
      // Loading indicator might not exist, that's okay
    }

    // Wait for course rows to be present (or updated)
    try {
      await page.waitForSelector('tr, [class*="course"], [data-testid*="course"]', { timeout: 10000 });
    } catch (error) {
      // Course rows might not be visible yet, wait a bit more
      await page.waitForTimeout(2000);
    }

    // Additional wait for React to re-render
    await page.waitForTimeout(500);
  } catch (error) {
    console.warn("Warning while waiting for school filter update:", error);
    // Don't throw - just wait a bit longer as fallback
    await page.waitForTimeout(2000);
  }
}

