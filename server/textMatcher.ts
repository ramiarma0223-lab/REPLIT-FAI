import { PDFTextItem, PDFPageInfo } from './pdfParser';

export interface TextMatch {
  text: string;
  page: number; // 0-indexed
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number; // 0-1
}

/**
 * Fuzzy match extracted characteristic text with PDF text positions
 * Uses Levenshtein distance for similarity matching
 */
export function findTextPosition(
  searchText: string,
  pdfPages: PDFPageInfo[],
  minConfidence: number = 0.7
): TextMatch | null {
  let bestMatch: TextMatch | null = null;
  let bestSimilarity = 0;

  // Clean search text for matching
  const cleanSearch = cleanText(searchText);

  for (const pageInfo of pdfPages) {
    for (const textItem of pageInfo.textItems) {
      const cleanItem = cleanText(textItem.text);
      
      // Try exact match first
      if (cleanItem === cleanSearch) {
        return {
          text: textItem.text,
          page: pageInfo.pageNumber - 1, // Convert to 0-indexed
          x: textItem.x,
          y: textItem.y,
          width: textItem.width,
          height: textItem.height,
          confidence: 1.0
        };
      }

      // Try substring match
      if (cleanItem.includes(cleanSearch) || cleanSearch.includes(cleanItem)) {
        const similarity = Math.max(
          cleanSearch.length / cleanItem.length,
          cleanItem.length / cleanSearch.length
        );
        
        if (similarity > bestSimilarity && similarity >= minConfidence) {
          bestSimilarity = similarity;
          bestMatch = {
            text: textItem.text,
            page: pageInfo.pageNumber - 1,
            x: textItem.x,
            y: textItem.y,
            width: textItem.width,
            height: textItem.height,
            confidence: similarity
          };
        }
      }

      // Try fuzzy match
      const similarity = calculateSimilarity(cleanSearch, cleanItem);
      if (similarity > bestSimilarity && similarity >= minConfidence) {
        bestSimilarity = similarity;
        bestMatch = {
          text: textItem.text,
          page: pageInfo.pageNumber - 1,
          x: textItem.x,
          y: textItem.y,
          width: textItem.width,
          height: textItem.height,
          confidence: similarity
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Find bounding box for dimension value in PDF
 * Handles various dimension formats: "2.500 ±.005", "Ø.250", etc.
 */
export function findDimensionPosition(
  description: string,
  nominalValue: number | undefined,
  tolerancePlus: number | undefined,
  toleranceMinus: number | undefined,
  unit: string | undefined,
  pdfPages: PDFPageInfo[]
): TextMatch | null {
  // Build search patterns
  const searchPatterns: string[] = [];

  if (nominalValue !== undefined && nominalValue !== 0) {
    // Try nominal value with tolerances
    if (tolerancePlus && toleranceMinus) {
      searchPatterns.push(`${nominalValue} ±${tolerancePlus}`);
      searchPatterns.push(`${nominalValue}±${tolerancePlus}`);
      searchPatterns.push(`${nominalValue} +${tolerancePlus} -${toleranceMinus}`);
    }
    
    // Try just nominal value
    searchPatterns.push(nominalValue.toString());
  }

  // Try description text (might contain dimension in description)
  searchPatterns.push(description);

  // Search for each pattern
  for (const pattern of searchPatterns) {
    const match = findTextPosition(pattern, pdfPages, 0.6); // Lower threshold for dimensions
    if (match) {
      return match;
    }
  }

  return null;
}

/**
 * Find bounding box for GD&T callout
 * Handles geometric tolerance symbols
 */
export function findGDTPosition(
  description: string,
  gdtType: string | undefined,
  pdfPages: PDFPageInfo[]
): TextMatch | null {
  const searchPatterns: string[] = [];

  // Add GD&T symbol if present
  if (gdtType) {
    searchPatterns.push(gdtType);
  }

  // Add description
  searchPatterns.push(description);

  for (const pattern of searchPatterns) {
    const match = findTextPosition(pattern, pdfPages, 0.7);
    if (match) {
      return match;
    }
  }

  return null;
}

/**
 * Find bounding box for note/material/process text
 */
export function findNotePosition(
  description: string,
  pdfPages: PDFPageInfo[]
): TextMatch | null {
  // Notes often have exact text matches
  return findTextPosition(description, pdfPages, 0.8);
}

/**
 * Clean text for comparison (remove whitespace, lowercase, etc.)
 */
function cleanText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ') // Normalize whitespace
    .replace(/[^\w\s.±°Ø∅]/g, '') // Keep alphanumeric, space, and common symbols
    .trim();
}

/**
 * Calculate similarity between two strings using Levenshtein distance
 * Returns value between 0 (completely different) and 1 (identical)
 */
function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) {
    return 1.0;
  }
  
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}
