import { ExtractedCharacteristic } from './gemini';
import { PDFPageInfo, extractPDFTextPositions } from './pdfParser';
import { findDimensionPosition, findGDTPosition, findNotePosition, TextMatch } from './textMatcher';
import { pdfAnnotator, AnnotationBox } from './pdfAnnotator';
import { db } from './db';
import { drawingAnnotations, drawings } from '../shared/schema';
import { eq } from 'drizzle-orm';

// Tiered confidence thresholds per architect guidance
const CONFIDENCE_THRESHOLDS = {
  note: 0.8,         // High threshold for exact text matching
  material: 0.8,     // High threshold for material specs
  process: 0.8,      // High threshold for process notes
  dimension: 0.55,   // Lower threshold for dimension formats
  gdt: 0.55,         // Lower threshold for GD&T symbols
  functional: 0.7    // Medium threshold for functional tests
};

export interface AnnotationGenerationResult {
  success: boolean;
  annotatedPdfUrl?: string;
  annotationCount: number;
  matchedCount: number;
  errors?: string[];
}

/**
 * Generate PDF annotations for extracted characteristics
 * Best-effort: extraction succeeds even if annotation generation fails
 */
export async function generateAnnotations(
  drawingId: string,
  pdfBuffer: Buffer,
  characteristics: ExtractedCharacteristic[],
  objectStorageService: any // Accept configured singleton
): Promise<AnnotationGenerationResult> {
  const errors: string[] = [];
  
  try {
    console.log(`[Annotation] Starting annotation generation for drawing ${drawingId}`);
    console.log(`[Annotation] Processing ${characteristics.length} characteristics`);
    
    // Step 1: Extract PDF text positions (cached for all matchers)
    console.log(`[Annotation] Extracting PDF text positions...`);
    const pdfPages = await extractPDFTextPositions(pdfBuffer);
    console.log(`[Annotation] Found ${pdfPages.reduce((sum, p) => sum + p.textItems.length, 0)} text items across ${pdfPages.length} pages`);
    
    // Step 2: Match characteristics with PDF text positions
    // CRITICAL: Store matches temporarily, only mutate characteristics AFTER DB persistence succeeds
    console.log(`[Annotation] Matching characteristics with PDF positions...`);
    let matchedCount = 0;
    const annotations: AnnotationBox[] = [];
    const annotationRecords: Array<{
      drawingId: string;
      extractionKey: string;
      page: number;
      annotationType: string;
      x: number;
      y: number;
      width: number;
      height: number;
      textSnippet: string;
      aiConfidence: number;
      status: string;
    }> = [];
    const locationMatches = new Map<ExtractedCharacteristic, TextMatch>(); // Temporary storage
    
    for (let i = 0; i < characteristics.length; i++) {
      const char = characteristics[i];
      const extractionKey = `${i}`; // Use index as stable extraction key
      
      try {
        let match: TextMatch | null = null;
        const threshold = CONFIDENCE_THRESHOLDS[char.requirementType as keyof typeof CONFIDENCE_THRESHOLDS] || 0.7;
        
        // Route to appropriate matcher based on requirement type
        if (char.requirementType === 'dimension' && !char.gdtType) {
          match = findDimensionPosition(
            char.description,
            char.nominalValue,
            char.tolerancePlus,
            char.toleranceMinus,
            char.unit,
            pdfPages
          );
        } else if (char.gdtType) {
          // GD&T callouts (can be dimension or separate requirement)
          match = findGDTPosition(char.description, char.gdtType, pdfPages);
        } else {
          // note, material, process, functional
          match = findNotePosition(char.description, pdfPages);
        }
        
        // Record match if confidence meets threshold
        if (match && match.confidence >= threshold) {
          // Store match temporarily - do NOT mutate characteristic yet
          locationMatches.set(char, match);
          
          // Map requirement type to annotation type
          let annotationType: AnnotationBox['type'] = 'dimension';
          if (char.gdtType) annotationType = 'gdt';
          else if (char.requirementType === 'material') annotationType = 'material';
          else if (char.requirementType === 'process') annotationType = 'process';
          else if (char.requirementType === 'note') annotationType = 'note';
          else if (char.requirementType === 'functional') annotationType = 'functional_test';
          
          // Create annotation box for PDF rendering
          annotations.push({
            x: match.x,
            y: match.y,
            width: match.width,
            height: match.height,
            type: annotationType,
            text: match.text,
            page: match.page
          });
          
          // Create annotation record for database (with extractionKey for backfilling)
          annotationRecords.push({
            drawingId,
            extractionKey, // Store index for later characteristicId backfill
            page: match.page,
            annotationType,
            x: match.x,
            y: match.y,
            width: match.width,
            height: match.height,
            textSnippet: match.text,
            aiConfidence: match.confidence,
            status: 'ai_generated'
          });
          
          matchedCount++;
          console.log(`[Annotation] ✓ Matched "${char.description.substring(0, 40)}..." (confidence: ${match.confidence.toFixed(2)})`);
        } else {
          const reason = !match ? 'no match found' : `confidence ${match.confidence.toFixed(2)} < threshold ${threshold}`;
          console.log(`[Annotation] ✗ Failed to match "${char.description.substring(0, 40)}..." (${reason})`);
        }
      } catch (error) {
        const errorMsg = `Failed to match characteristic "${char.description}": ${error}`;
        console.error(`[Annotation] ${errorMsg}`);
        errors.push(errorMsg);
      }
    }
    
    console.log(`[Annotation] Matched ${matchedCount}/${characteristics.length} characteristics`);
    
    // Step 3: Persist annotation records to database
    if (annotationRecords.length > 0) {
      console.log(`[Annotation] Persisting ${annotationRecords.length} annotation records...`);
      try {
        await db.insert(drawingAnnotations).values(annotationRecords);
        console.log(`[Annotation] ✓ Saved ${annotationRecords.length} annotation records`);
        
        // SUCCESS: Now safe to mutate characteristics with normalized location data
        for (const [char, match] of Array.from(locationMatches.entries())) {
          // Get page dimensions for normalization
          // match.page is 0-indexed, pdfPages has 1-indexed pageNumber
          const pageInfo = pdfPages.find(p => p.pageNumber === match.page + 1);
          if (!pageInfo) {
            console.error(`[Annotation] Cannot normalize - page ${match.page + 1} not found in pdfPages`);
            continue;
          }
          
          // Normalize coordinates to 0-1 range relative to page dimensions
          char.location = {
            x: match.x / pageInfo.width,
            y: match.y / pageInfo.height,
            width: match.width / pageInfo.width,
            height: match.height / pageInfo.height,
            page: match.page,
            confidence: match.confidence
          };
          
          // Validation: ensure normalized values are in [0,1] range
          if (char.location.x < 0 || char.location.x > 1 || 
              char.location.y < 0 || char.location.y > 1 ||
              char.location.width < 0 || char.location.width > 1 ||
              char.location.height < 0 || char.location.height > 1) {
            console.warn(`[Annotation] Normalized coordinates out of range for char: ${char.description}`, char.location);
          }
        }
        console.log(`[Annotation] ✓ Updated ${locationMatches.size} characteristics with normalized location data`);
      } catch (error) {
        const errorMsg = `Failed to persist annotation records: ${error}`;
        console.error(`[Annotation] ${errorMsg}`);
        errors.push(errorMsg);
        // CRITICAL: Do not mutate characteristics - DB persistence failed
        throw error; // Abort annotation generation
      }
    }
    
    // Step 4: Generate annotated PDF (best-effort)
    let annotatedPdfUrl: string | undefined;
    if (annotations.length > 0) {
      try {
        console.log(`[Annotation] Generating annotated PDF with ${annotations.length} highlights...`);
        const annotatedBuffer = await pdfAnnotator.generateAnnotatedPDF(pdfBuffer, annotations);
        
        // Upload to object storage using existing service
        console.log(`[Annotation] Uploading annotated PDF...`);
        annotatedPdfUrl = await objectStorageService.uploadFile(
          annotatedBuffer,
          `drawings/${drawingId}_annotated.pdf`,
          'application/pdf'
        );
        
        // Update drawing record with annotated PDF URL
        await db.update(drawings)
          .set({ annotatedPdfUrl })
          .where(eq(drawings.id, drawingId));
        
        console.log(`[Annotation] ✓ Annotated PDF uploaded: ${annotatedPdfUrl}`);
      } catch (error) {
        const errorMsg = `Failed to generate/upload annotated PDF: ${error}`;
        console.error(`[Annotation] ${errorMsg}`);
        errors.push(errorMsg);
        // Non-critical: extraction can continue without annotated PDF
      }
    } else {
      console.log(`[Annotation] No annotations to render - skipping PDF generation`);
    }
    
    // Log telemetry for threshold tuning
    console.log(`[Annotation Telemetry] Match rate: ${(matchedCount / characteristics.length * 100).toFixed(1)}%`);
    console.log(`[Annotation Telemetry] Annotations created: ${annotationRecords.length}`);
    console.log(`[Annotation Telemetry] Errors: ${errors.length}`);
    
    return {
      success: true,
      annotatedPdfUrl,
      annotationCount: annotationRecords.length,
      matchedCount,
      errors: errors.length > 0 ? errors : undefined
    };
    
  } catch (error) {
    const errorMsg = `Annotation generation failed: ${error}`;
    console.error(`[Annotation] ${errorMsg}`);
    errors.push(errorMsg);
    
    return {
      success: false,
      annotationCount: 0,
      matchedCount: 0,
      errors
    };
  }
}
