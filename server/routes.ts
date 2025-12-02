import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import { storage } from "./storage";
import { db } from "./db";
import { characteristics, drawings, drawingAnnotations, insertAnnotationFeedbackSchema } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { extractDimensionsFromDrawing } from "./gemini";
import { ObjectStorageService } from "./objectStorage";
import { extractPDFTextPositions, extractPDFPageDimensions, findDimensionTextPosition, detectDrawingOrigin } from "./pdfParser";
import {
  insertProjectSchema,
  insertDrawingSchema,
  insertCharacteristicSchema,
  manualCharacteristicInputSchema,
  insertBalloonSchema,
  insertInspectionSchema,
  insertReportSchema,
  insertEquipmentSchema,
  insertInspectorSchema,
  normalizePassFail,
  type InsertCharacteristic,
} from "@shared/schema";
import { ZodError } from "zod";
import { jsPDF } from "jspdf";

const upload = multer({ storage: multer.memoryStorage() });
export const objectStorageService = new ObjectStorageService();

/**
 * Calculate AS9102-compliant drawing zone (e.g., "A-2", "D-3") from balloon position
 * Standard engineering drawing zones: Columns A-H (left-to-right), Rows 1-8 (bottom-to-top)
 * @param x Balloon X coordinate
 * @param y Balloon Y coordinate  
 * @param pageWidth Drawing page width in pixels
 * @param pageHeight Drawing page height in pixels
 * @returns Drawing zone string (e.g., "A-2", "D-3")
 * @throws Error if page dimensions are not positive finite numbers
 */
function calculateDrawingZone(
  x: number,
  y: number,
  pageWidth: number,
  pageHeight: number
): string {
  // DEFENSIVE: Reject invalid/zero/NaN/Infinity dimensions to prevent incorrect AS9102 zones
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) {
    throw new Error(`Invalid page dimensions for zone calculation: width=${pageWidth}, height=${pageHeight}`);
  }

  // Standard 8-column grid (A-H)
  const columns = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const columnWidth = pageWidth / columns.length;
  const columnIndex = Math.min(Math.floor(x / columnWidth), columns.length - 1);
  const column = columns[columnIndex];
  
  // Standard 8-row grid (1-8, bottom to top)
  const numRows = 8;
  const rowHeight = pageHeight / numRows;
  // Y increases downward in PDF coords, so invert for bottom-to-top numbering
  const rowIndex = Math.min(Math.floor((pageHeight - y) / rowHeight), numRows - 1);
  const row = rowIndex + 1;
  
  return `${column}-${row}`;
}

/**
 * Shared helper to compute leader offsets from balloon position
 * GUARANTEES leader distance ≥ MIN_LEADER_DISTANCE regardless of directional hints
 * @param xPosition Balloon X coordinate
 * @param yPosition Balloon Y coordinate
 * @param direction Optional hint for leader direction (default: right-down)
 * @returns Object with leaderX and leaderY coordinates guaranteed to be ≥5px from balloon
 */
function computeLeaderOffset(
  xPosition: number, 
  yPosition: number,
  direction?: { horizontal?: 'left' | 'right'; vertical?: 'up' | 'down' }
): { leaderX: number; leaderY: number } {
  const MIN_LEADER_DISTANCE = 5; // Must match storage validation
  let horizontalOffset = 30; // Default offset
  let verticalOffset = 15;   // Default offset
  
  const horizontalDir = direction?.horizontal || 'right';
  const verticalDir = direction?.vertical || 'down';
  
  // Compute initial leader position
  let leaderX = xPosition + (horizontalDir === 'right' ? horizontalOffset : -horizontalOffset);
  let leaderY = yPosition + (verticalDir === 'down' ? verticalOffset : -verticalOffset);
  
  // GUARANTEE: Ensure distance ≥ MIN_LEADER_DISTANCE
  // Dynamically increase offsets if needed (should never happen with defaults)
  let distance = Math.hypot(leaderX - xPosition, leaderY - yPosition);
  
  while (distance < MIN_LEADER_DISTANCE) {
    // Increase both offsets proportionally
    horizontalOffset += 10;
    verticalOffset += 5;
    leaderX = xPosition + (horizontalDir === 'right' ? horizontalOffset : -horizontalOffset);
    leaderY = yPosition + (verticalDir === 'down' ? verticalOffset : -verticalOffset);
    distance = Math.hypot(leaderX - xPosition, leaderY - yPosition);
  }
  
  return { leaderX, leaderY };
}

/**
 * Calculate dynamic balloon size based on total characteristic count
 * Ensures balloons fit cleanly on the page without overcrowding
 */
function calculateBalloonSize(totalCharacteristics: number): number {
  // Scale balloon diameter inversely with characteristic count
  // More characteristics = smaller balloons for better fit
  if (totalCharacteristics <= 20) return 24;      // Large balloons for few characteristics
  if (totalCharacteristics <= 40) return 20;      // Medium balloons
  if (totalCharacteristics <= 60) return 18;      // Smaller balloons
  if (totalCharacteristics <= 80) return 16;      // Even smaller
  return 14;                                       // Minimum size for 80+ characteristics
}

/**
 * Intelligent balloon placement in blank space near dimension/callout text
 * Dynamically sizes balloons based on total count for clean, professional appearance
 * Scans multiple positions around dimension to find optimal blank space
 * Avoids title blocks and drawing borders using detected drawing origin
 */
function computeSmartBalloonPlacement(
  textPosition: { x: number; y: number; width: number; height: number } | null,
  balloonNumber: number,
  pageWidth: number,
  pageHeight: number,
  existingBalloons: Array<{ xPosition: number; yPosition: number; balloonDiameter: number }>,
  totalCharacteristics: number,
  allTextItems: Array<{ x: number; y: number; width: number; height: number }> = [],
  drawingOrigin: { x: number; y: number } = { x: 0, y: 0 }
): { xPosition: number; yPosition: number; side: 'left' | 'right'; balloonDiameter: number } {
  const BALLOON_DIAMETER = calculateBalloonSize(totalCharacteristics);
  const MIN_TEXT_OFFSET = 15; // Minimum space between balloon and dimension text
  const PREFERRED_TEXT_OFFSET = 35; // Preferred space when possible
  const MIN_BALLOON_DISTANCE = BALLOON_DIAMETER + 5; // Dynamic spacing based on balloon size
  const MARGIN = 30; // Keep balloons away from page edges
  
  // Define drawing boundaries to avoid title blocks and borders
  // Standard engineering drawings have title blocks in bottom-right, borders all around
  const TITLE_BLOCK_HEIGHT = 120; // Bottom area reserved for title block
  const BORDER_MARGIN = 60; // Additional margin inside drawing border
  const drawingBounds = {
    left: drawingOrigin.x + BORDER_MARGIN,
    right: pageWidth - BORDER_MARGIN,
    top: drawingOrigin.y + BORDER_MARGIN,
    bottom: pageHeight - TITLE_BLOCK_HEIGHT - BORDER_MARGIN,
  };
  
  /**
   * Check if a position has enough blank space for balloon placement
   * Returns true if position is clear of existing balloons, text items, and drawing boundaries
   */
  const isBlankSpace = (x: number, y: number): boolean => {
    const radius = BALLOON_DIAMETER / 2;
    
    // CRITICAL: Check drawing boundaries first (avoid title blocks and borders)
    if (x - radius < drawingBounds.left || x + radius > drawingBounds.right ||
        y - radius < drawingBounds.top || y + radius > drawingBounds.bottom) {
      return false;
    }
    
    // Check page boundaries as backup
    if (x - radius < MARGIN || x + radius > pageWidth - MARGIN ||
        y - radius < MARGIN || y + radius > pageHeight - MARGIN) {
      return false;
    }
    
    // Check collision with existing balloons
    for (const existing of existingBalloons) {
      const existingRadius = existing.balloonDiameter / 2;
      const distance = Math.hypot(x - existing.xPosition, y - existing.yPosition);
      const minDistance = radius + existingRadius + 5; // 5px buffer
      if (distance < minDistance) {
        return false;
      }
    }
    
    // Check collision with text items (avoid overlapping drawing text)
    for (const textItem of allTextItems) {
      // Expand text bounds slightly for comfort
      const textLeft = textItem.x - 5;
      const textRight = textItem.x + textItem.width + 5;
      const textTop = textItem.y - 5;
      const textBottom = textItem.y + textItem.height + 5;
      
      // Check if balloon circle intersects with text rectangle
      const closestX = Math.max(textLeft, Math.min(x, textRight));
      const closestY = Math.max(textTop, Math.min(y, textBottom));
      const distance = Math.hypot(x - closestX, y - closestY);
      
      if (distance < radius) {
        return false; // Balloon would overlap text
      }
    }
    
    return true; // Position is clear!
  };
  
  /**
   * Check if a leader line from balloon to dimension would cross other balloons
   * Returns true if path is clear
   */
  const isLeaderPathClear = (balloonX: number, balloonY: number, targetX: number, targetY: number): boolean => {
    // Check if leader line segment intersects with any existing balloon circles
    for (const existing of existingBalloons) {
      const existingRadius = existing.balloonDiameter / 2;
      
      // Calculate distance from balloon center to line segment
      const lineLength = Math.hypot(targetX - balloonX, targetY - balloonY);
      if (lineLength === 0) continue;
      
      // Project existing balloon center onto line segment
      const t = Math.max(0, Math.min(1, 
        ((existing.xPosition - balloonX) * (targetX - balloonX) + 
         (existing.yPosition - balloonY) * (targetY - balloonY)) / (lineLength * lineLength)
      ));
      
      const projX = balloonX + t * (targetX - balloonX);
      const projY = balloonY + t * (targetY - balloonY);
      
      const distance = Math.hypot(existing.xPosition - projX, existing.yPosition - projY);
      
      // Leader would cross this balloon
      if (distance < existingRadius + 3) { // 3px buffer for leader line
        return false;
      }
    }
    
    return true; // Leader path is clear!
  };
  
  // If text position found, intelligently search for blank space near it
  if (textPosition) {
    // Generate candidate positions around the dimension in order of preference
    const centerY = textPosition.y + (textPosition.height / 2);
    const centerX = textPosition.x + (textPosition.width / 2);
    
    const candidatePositions = [
      // Right side (preferred)
      { x: textPosition.x + textPosition.width + PREFERRED_TEXT_OFFSET, y: centerY, side: 'right' as const },
      { x: textPosition.x + textPosition.width + MIN_TEXT_OFFSET, y: centerY, side: 'right' as const },
      
      // Left side
      { x: textPosition.x - PREFERRED_TEXT_OFFSET, y: centerY, side: 'left' as const },
      { x: textPosition.x - MIN_TEXT_OFFSET, y: centerY, side: 'left' as const },
      
      // Above (slightly to the right)
      { x: centerX + 10, y: textPosition.y - PREFERRED_TEXT_OFFSET, side: 'right' as const },
      { x: centerX + 10, y: textPosition.y - MIN_TEXT_OFFSET, side: 'right' as const },
      
      // Below (slightly to the right)
      { x: centerX + 10, y: textPosition.y + textPosition.height + PREFERRED_TEXT_OFFSET, side: 'right' as const },
      { x: centerX + 10, y: textPosition.y + textPosition.height + MIN_TEXT_OFFSET, side: 'right' as const },
      
      // Diagonal positions (backup options)
      { x: textPosition.x + textPosition.width + PREFERRED_TEXT_OFFSET, y: centerY - 20, side: 'right' as const },
      { x: textPosition.x + textPosition.width + PREFERRED_TEXT_OFFSET, y: centerY + 20, side: 'right' as const },
      { x: textPosition.x - PREFERRED_TEXT_OFFSET, y: centerY - 20, side: 'left' as const },
      { x: textPosition.x - PREFERRED_TEXT_OFFSET, y: centerY + 20, side: 'left' as const },
    ];
    
    // Find first blank space position with clear leader path
    const textCenterX = textPosition.x + textPosition.width / 2;
    const textCenterY = textPosition.y + textPosition.height / 2;
    
    for (const candidate of candidatePositions) {
      // Check both blank space AND leader path clearance
      if (isBlankSpace(candidate.x, candidate.y) && 
          isLeaderPathClear(candidate.x, candidate.y, textCenterX, textCenterY)) {
        return { 
          xPosition: candidate.x, 
          yPosition: candidate.y, 
          side: candidate.side,
          balloonDiameter: BALLOON_DIAMETER
        };
      }
    }
    
    // If no perfect blank space found, try fallback adjustments
    // CRITICAL: Must validate BOTH blank space AND leader path clearance
    const textCenterXFallback = textPosition.x + textPosition.width / 2;
    const textCenterYFallback = textPosition.y + textPosition.height / 2;
    
    for (const candidate of candidatePositions) {
      let xPosition = candidate.x;
      let yPosition = candidate.y;
      
      // Try vertical adjustments (±100px in 10px steps)
      // CRITICAL: Start at offsetY=10 to avoid re-checking the already-rejected candidate at offset=0
      for (let offsetY = 10; offsetY <= 100; offsetY += 10) {
        // Try offset down
        if (isBlankSpace(xPosition, yPosition + offsetY) && 
            isLeaderPathClear(xPosition, yPosition + offsetY, textCenterXFallback, textCenterYFallback)) {
          return { 
            xPosition, 
            yPosition: yPosition + offsetY, 
            side: candidate.side, 
            balloonDiameter: BALLOON_DIAMETER 
          };
        }
        
        // Try offset up
        if (isBlankSpace(xPosition, yPosition - offsetY) && 
            isLeaderPathClear(xPosition, yPosition - offsetY, textCenterXFallback, textCenterYFallback)) {
          return { 
            xPosition, 
            yPosition: yPosition - offsetY, 
            side: candidate.side, 
            balloonDiameter: BALLOON_DIAMETER 
          };
        }
      }
    }
    
    // All adjustments failed - fall back to perimeter placement
    // This guarantees a placement even in worst-case scenarios
    console.warn(`Balloon #${balloonNumber}: All smart positions blocked, using perimeter fallback`);
    const perimeterPos = computePerimeterBalloonLayout(balloonNumber, totalCharacteristics, pageWidth, pageHeight);
    return { ...perimeterPos, balloonDiameter: BALLOON_DIAMETER };
  }
  
  // Fallback: perimeter placement for non-dimensional items (notes, materials, etc.)
  const perimeterPos = computePerimeterBalloonLayout(balloonNumber, totalCharacteristics, pageWidth, pageHeight);
  return { ...perimeterPos, balloonDiameter: BALLOON_DIAMETER };
}

/**
 * Industry-standard FAI balloon perimeter layout (FALLBACK ONLY)
 * Used when dimension text position cannot be found
 */
function computePerimeterBalloonLayout(
  balloonNumber: number,
  totalBalloons: number,
  pageWidth: number,
  pageHeight: number
): { xPosition: number; yPosition: number; side: 'left' | 'right' } {
  // Industry standards for FAI ballooning
  const MARGIN_FROM_EDGE = 40; // Distance from page edge (in PDF points)
  const TOP_MARGIN = 120; // Space for title block at top
  const BOTTOM_MARGIN = 80; // Space for notes at bottom
  const MIN_BALLOON_SPACING = 25; // Minimum vertical spacing
  const PREFERRED_BALLOON_SPACING = 35; // Preferred vertical spacing
  
  // Available vertical space for balloons
  const availableHeight = pageHeight - TOP_MARGIN - BOTTOM_MARGIN;
  
  // Calculate max balloons that fit in a single column at minimum spacing
  const maxBalloonsPerColumn = Math.floor(availableHeight / MIN_BALLOON_SPACING) + 1;
  
  // Determine number of columns needed (2 or 4)
  // Use 4 columns when balloon count exceeds capacity of 2 columns
  const numColumns = (totalBalloons > maxBalloonsPerColumn * 2) ? 4 : 2;
  const balloonsPerColumn = Math.ceil(totalBalloons / numColumns);
  
  // Warn if balloon count exceeds recommended capacity
  const maxRecommendedCapacity = maxBalloonsPerColumn * 4; // ~96 for standard page
  if (balloonNumber === 1 && totalBalloons > maxRecommendedCapacity) {
    console.warn(`WARNING: ${totalBalloons} balloons exceeds recommended capacity of ${maxRecommendedCapacity} for single-page FAI report.`);
    console.warn(`Consider splitting into multiple drawings or pages for optimal readability.`);
  }
  
  // Determine which column and position within that column
  const columnNumber = (balloonNumber - 1) % numColumns; // 0, 1, 2, or 3
  const columnIndex = Math.floor((balloonNumber - 1) / numColumns); // Position in column
  
  // Calculate dynamic spacing to fit balloons
  let balloonSpacing = PREFERRED_BALLOON_SPACING;
  if (balloonsPerColumn > 1) {
    const requiredSpacing = availableHeight / (balloonsPerColumn - 1);
    balloonSpacing = Math.max(MIN_BALLOON_SPACING, Math.min(PREFERRED_BALLOON_SPACING, requiredSpacing));
  }
  
  // Calculate X position based on column number
  // For 2 columns: 0=left, 1=right
  // For 4 columns: 0=far-left, 1=left-center, 2=right-center, 3=far-right
  let xPosition: number;
  let side: 'left' | 'right';
  
  if (numColumns === 2) {
    xPosition = columnNumber === 0 ? MARGIN_FROM_EDGE : pageWidth - MARGIN_FROM_EDGE;
    side = columnNumber === 0 ? 'left' : 'right';
  } else {
    // 4-column layout
    const columnPositions = [
      MARGIN_FROM_EDGE,                      // Far left
      pageWidth * 0.25,                      // Left-center
      pageWidth * 0.75,                      // Right-center
      pageWidth - MARGIN_FROM_EDGE           // Far right
    ];
    xPosition = columnPositions[columnNumber];
    side = columnNumber < 2 ? 'left' : 'right';
  }
  
  // Calculate Y position
  const yPosition = TOP_MARGIN + (columnIndex * balloonSpacing);
  
  // DEFENSIVE: Clamp to page bounds (should not be needed with correct spacing)
  const maxYPosition = pageHeight - BOTTOM_MARGIN;
  const clampedYPosition = Math.min(yPosition, maxYPosition);
  
  if (yPosition > maxYPosition) {
    console.warn(`Balloon #${balloonNumber}: Y position ${yPosition.toFixed(0)} exceeds page height, clamped to ${maxYPosition}`);
  }
  
  return {
    xPosition,
    yPosition: clampedYPosition,
    side
  };
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Serve public drawings from object storage
  app.get("/public-objects/:filePath(*)", async (req, res) => {
    const filePath = req.params.filePath;
    try {
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        return res.status(404).json({ error: "File not found" });
      }
      await objectStorageService.downloadObject(file, res);
    } catch (error) {
      console.error("Error serving public object:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // Projects
  app.get("/api/projects", async (_req, res) => {
    try {
      const projects = await storage.getProjects();
      res.json(projects);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch projects" });
    }
  });

  app.post("/api/projects", async (req, res) => {
    try {
      const data = insertProjectSchema.parse(req.body);
      const project = await storage.createProject(data);
      res.json(project);
    } catch (error) {
      res.status(400).json({ error: "Invalid project data" });
    }
  });

  app.delete("/api/projects/:id", async (req, res) => {
    try {
      await storage.deleteProject(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete project" });
    }
  });

  // Drawings
  app.get("/api/drawings", async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      const drawings = await storage.getDrawings(projectId);
      res.json(drawings);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch drawings" });
    }
  });

  // Get annotation metadata for a drawing (for viewer overlay)
  app.get("/api/drawings/:id/annotations", async (req, res) => {
    try {
      const { id } = req.params;
      const annotations = await storage.getDrawingAnnotations(id);
      res.json(annotations);
    } catch (error) {
      console.error("Failed to fetch annotations:", error);
      res.status(500).json({ error: "Failed to fetch annotations" });
    }
  });

  // Submit annotation feedback for continuous learning
  app.post("/api/annotations/feedback", async (req, res) => {
    try {
      const data = insertAnnotationFeedbackSchema.parse(req.body);
      const feedback = await storage.createAnnotationFeedback(data);
      
      // Update annotation status based on feedback type
      if (data.feedbackType === 'accepted') {
        await storage.updateAnnotationStatus(data.annotationId, 'user_validated', data.submittedBy);
      } else if (['corrected', 'deleted', 'false_positive', 'false_negative'].includes(data.feedbackType)) {
        await storage.updateAnnotationStatus(data.annotationId, 'user_corrected', data.submittedBy);
      }
      
      res.json(feedback);
    } catch (error) {
      console.error("Failed to submit annotation feedback:", error);
      if (error instanceof ZodError) {
        return res.status(400).json({ error: "Invalid feedback data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to submit feedback" });
    }
  });

  const uploadedPDFs = new Map<string, Buffer>(); // Store PDFs in memory

  app.post("/api/drawings/upload", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const uploadURL = await objectStorageService.getUploadURL(req.file.originalname);
      
      const uploadResponse = await fetch(uploadURL, {
        method: "PUT",
        body: req.file.buffer,
        headers: {
          "Content-Type": req.file.mimetype,
        },
      });

      if (!uploadResponse.ok) {
        return res.status(500).json({ error: "Failed to upload file" });
      }

      // Convert Google Storage URL to local public-objects URL
      const baseUrl = uploadURL.split("?")[0];
      // Extract the path after the bucket name
      const urlParts = new URL(baseUrl);
      const pathParts = urlParts.pathname.split("/").filter(p => p);
      // Skip bucket name AND "public" folder, keep rest (e.g., "drawings/123-file.pdf")
      // Path structure: /bucket-name/public/drawings/file.pdf
      const objectPath = pathParts.slice(2).join("/"); // Skip both bucket and "public"
      const pdfUrl = `/public-objects/${objectPath}`;

      // Extract page dimensions for AS9102 zone calculation
      const pageDimensions = await extractPDFPageDimensions(req.file.buffer);
      
      const drawing = await storage.createDrawing({
        projectId: req.body.projectId,
        name: req.file.originalname,
        pdfUrl,
        thumbnailUrl: null,
        pageWidth: pageDimensions?.width ?? null,
        pageHeight: pageDimensions?.height ?? null,
      });

      // Store PDF buffer in memory for AI extraction
      uploadedPDFs.set(drawing.id, req.file.buffer);

      res.json(drawing);
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Failed to process upload" });
    }
  });

  // Backfill page dimensions for legacy drawings
  app.post("/api/drawings/:id/backfill-dimensions", async (req, res) => {
    try {
      const { id } = req.params;
      const drawing = await storage.getDrawing(id);
      
      if (!drawing) {
        return res.status(404).json({ error: "Drawing not found" });
      }
      
      // Check if dimensions already exist
      if (drawing.pageWidth && drawing.pageHeight) {
        return res.json({ 
          message: "Drawing already has valid dimensions", 
          pageWidth: drawing.pageWidth, 
          pageHeight: drawing.pageHeight 
        });
      }
      
      // Fetch PDF from storage
      let pdfBuffer = uploadedPDFs.get(id);
      if (!pdfBuffer) {
        try {
          const signedPdfUrl = await objectStorageService.getDownloadURL(drawing.pdfUrl);
          const pdfResponse = await fetch(signedPdfUrl);
          
          if (!pdfResponse.ok) {
            return res.status(500).json({ error: "Failed to fetch PDF from storage" });
          }
          
          pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
        } catch (error) {
          console.error("Failed to fetch from storage:", error);
          return res.status(500).json({ error: "PDF not accessible" });
        }
      }
      
      // Extract and update dimensions
      const pageDimensions = await extractPDFPageDimensions(pdfBuffer);
      if (!pageDimensions) {
        return res.status(422).json({
          error: "Cannot extract PDF page dimensions",
          details: "The PDF does not contain measurable page dimensions. This may be due to a malformed or encrypted PDF."
        });
      }
      
      await db.update(drawings)
        .set({ 
          pageWidth: pageDimensions.width, 
          pageHeight: pageDimensions.height 
        })
        .where(eq(drawings.id, id));
      
      const updatedDrawing = await storage.getDrawing(id);
      
      res.json({ 
        message: "Dimensions backfilled successfully", 
        pageWidth: updatedDrawing!.pageWidth, 
        pageHeight: updatedDrawing!.pageHeight 
      });
    } catch (error) {
      console.error("Backfill error:", error);
      res.status(500).json({ error: "Failed to backfill dimensions" });
    }
  });

  // AI Extraction
  app.post("/api/drawings/extract", async (req, res) => {
    try {
      const { drawingId } = req.body;
      let drawing = await storage.getDrawing(drawingId); // Changed to let for reassignment after dimension extraction
      
      if (!drawing) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      // Try to get PDF from memory first, fall back to storage
      let pdfBuffer = uploadedPDFs.get(drawingId);
      
      if (!pdfBuffer) {
        try {
          const signedPdfUrl = await objectStorageService.getDownloadURL(drawing.pdfUrl);
          const pdfResponse = await fetch(signedPdfUrl);
          
          if (!pdfResponse.ok) {
            return res.status(500).json({ error: "Failed to fetch PDF from storage" });
          }
          
          pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
        } catch (error) {
          console.error("Failed to fetch from storage:", error);
          return res.status(500).json({ error: "PDF not accessible" });
        }
      }
      
      const pdfBase64 = pdfBuffer.toString("base64");

      // Extract page dimensions for AS9102 zone calculation (if not already set)
      if (!drawing.pageWidth || !drawing.pageHeight) {
        const pageDimensions = await extractPDFPageDimensions(pdfBuffer);
        if (pageDimensions) {
          await db.update(drawings)
            .set({ 
              pageWidth: pageDimensions.width, 
              pageHeight: pageDimensions.height 
            })
            .where(eq(drawings.id, drawingId));
          // Refresh drawing object with newly extracted dimensions
          drawing = (await storage.getDrawing(drawingId))!;
          
          // CRITICAL: Verify the DB update actually persisted the dimensions
          // If refresh still shows null/undefined, this indicates a DB write failure (not PDF parsing issue)
          // Use explicit null checks (not truthiness) to allow small positive values like 0.72
          if (drawing.pageWidth == null || drawing.pageHeight == null || 
              !Number.isFinite(drawing.pageWidth) || !Number.isFinite(drawing.pageHeight)) {
            console.error("DB update failed - dimensions did not persist after extraction");
            return res.status(500).json({
              error: "Database update failed",
              details: "Page dimensions were extracted successfully but failed to persist to database. This may indicate a database constraint or transaction error."
            });
          }
          
          console.log(`Page dimensions extracted and verified: ${drawing.pageWidth}x${drawing.pageHeight}`);
        } else {
          // Extraction failed - return clear error before proceeding to validation
          console.error("PDF page dimensions could not be extracted - PDF may be malformed or encrypted");
          return res.status(422).json({
            error: "Cannot extract PDF page dimensions",
            details: "The PDF does not contain measurable page dimensions. This may be due to a malformed or encrypted PDF. AS9102 zone calculation requires valid page dimensions."
          });
        }
      }

      // Extract characteristics and metadata using AI (enhanced with template filtering)
      const extractionResult = await extractDimensionsFromDrawing(pdfBase64);
      // Note: extractDimensionsFromDrawing returns 'dimensions' for backward compatibility, but they're now full characteristics
      const { dimensions: allCharacteristics, metadata } = extractionResult;

      // CRITICAL FILTERING: Only keep characteristics classified as "part" features
      // Filter out "template" characteristics (title block, general notes, etc.)
      const partCharacteristics = allCharacteristics.filter(char => char.region === "part");
      const templateCharacteristics = allCharacteristics.filter(char => char.region === "template");
      const uncertainCharacteristics = allCharacteristics.filter(char => char.region === "uncertain");

      console.log(`AI Classification Results: ${partCharacteristics.length} part, ${templateCharacteristics.length} template, ${uncertainCharacteristics.length} uncertain`);
      
      if (templateCharacteristics.length > 0) {
        console.log("Filtered out template characteristics:", templateCharacteristics.map((char: any) => char.description).join(", "));
      }

      // Persist filtered characteristics for audit trail (template and uncertain)
      // CRITICAL: ALWAYS persist audit trail BEFORE checking part count
      // This ensures compliance even when extraction finds only template elements
      // NOTE: Only persist characteristics with numeric values (dimensions) to filtered_dimensions table
      // Non-dimensional notes/materials are logged but not persisted (schema requires notNull nominalValue/unit)
      const filteredToSave = [...templateCharacteristics, ...uncertainCharacteristics]
        .filter(dim => dim.nominalValue != null && dim.unit != null); // Only save measurable dimensions
      
      if (filteredToSave.length > 0) {
        console.log(`Persisting ${filteredToSave.length} filtered dimensions to audit trail...`);
        await Promise.all(
          filteredToSave.map(async (dim) => {
            return await storage.createFilteredDimension({
              drawingId: drawing.id,
              description: dim.description,
              nominalValue: dim.nominalValue!, // Safe due to filter above
              tolerancePlus: dim.tolerancePlus ?? null,
              toleranceMinus: dim.toleranceMinus ?? null,
              unit: dim.unit!, // Safe due to filter above
              gdtType: dim.gdtType || null,
              gdtTolerance: dim.gdtTolerance ?? null,
              region: dim.region, // "template" or "uncertain"
              filterReason: dim.region === "template" 
                ? "Classified as template element (title block, notes, etc.)"
                : "Classification uncertain - may need manual review",
            });
          })
        );
        console.log(`Successfully persisted ${filteredToSave.length} filtered dimensions`);
      } else {
        const nonNumericCount = [...templateCharacteristics, ...uncertainCharacteristics].length;
        if (nonNumericCount > 0) {
          console.log(`Skipped persisting ${nonNumericCount} non-dimensional filtered characteristics (notes/materials without numeric values)`);
        }
      }

      // Save part metadata separately from dimensions
      if (metadata && Object.keys(metadata).filter(k => metadata[k as keyof typeof metadata]).length > 0) {
        try {
          await storage.createPartMetadata({
            drawingId: drawing.id,
            material: metadata.material || null,
            surfaceFinish: metadata.surfaceFinish || null,
            deburringRequirements: metadata.deburringRequirements || null,
            breakCorners: metadata.breakCorners || null,
            partMark: metadata.partMark || null,
            installationNotes: metadata.installationNotes || null,
            generalNotes: metadata.generalNotes || null, // Array preserved
          });
          console.log("Part metadata saved successfully");
        } catch (error) {
          console.error("Failed to save part metadata:", error);
          // Don't fail the whole extraction if metadata save fails
        }
      }

      const sourceCharacteristics = partCharacteristics; // Only create characteristics for part features

      // If no part characteristics found, return success with classification summary
      // Audit trail already persisted above for compliance
      if (!sourceCharacteristics || sourceCharacteristics.length === 0) {
        console.log("No part characteristics found - returning classification summary only");
        return res.json({
          characteristics: [],
          balloons: [],
          classificationSummary: {
            total: allCharacteristics.length,
            part: 0,
            template: templateCharacteristics.length,
            uncertain: uncertainCharacteristics.length,
            message: "AI extraction completed but found no measurable part characteristics. All extracted characteristics were classified as template elements (title block, notes, etc.). Check the audit trail for details.",
            templateCharacteristics: templateCharacteristics.map((char: any) => ({
              description: char.description,
              requirementType: char.requirementType,
              value: char.nominalValue != null ? `${char.nominalValue} ${char.unit || ''}`.trim() : 'N/A',
              reason: "Classified as template element (title block, notes, etc.)"
            })),
            uncertainCharacteristics: uncertainCharacteristics.map((char: any) => ({
              description: char.description,
              requirementType: char.requirementType,
              value: char.nominalValue != null ? `${char.nominalValue} ${char.unit || ''}`.trim() : 'N/A',
              reason: "Classification uncertain - may need manual review"
            })),
          },
          metadata: metadata
        });
      }

      // Extract text positions from PDF for intelligent balloon placement
      console.log("Extracting PDF text positions for balloon placement...");
      const pdfPages = await extractPDFTextPositions(pdfBuffer);
      const firstPage = pdfPages[0]; // Most engineering drawings are single-page
      
      if (!firstPage) {
        console.warn("Could not extract PDF page info, using fallback positioning");
      }

      // Detect drawing origin for coordinate reference
      let drawingOrigin = { x: 0, y: 0 };
      if (firstPage) {
        drawingOrigin = detectDrawingOrigin(firstPage);
        console.log(`Drawing origin detected at (${drawingOrigin.x.toFixed(0)}, ${drawingOrigin.y.toFixed(0)})`);
      }

      // Generate PDF annotations with color-coded highlights (best-effort)
      // This creates visual validation of AI extraction and enables learning
      try {
        const { generateAnnotations } = await import('./annotationGenerator');
        const annotationResult = await generateAnnotations(
          drawing.id,
          pdfBuffer,
          sourceCharacteristics, // Use part characteristics for annotation
          objectStorageService // Pass configured singleton
        );
        
        console.log(`Annotation generation: ${annotationResult.success ? 'SUCCESS' : 'FAILED'}`);
        console.log(`  Matched: ${annotationResult.matchedCount}/${sourceCharacteristics.length}`);
        console.log(`  Annotations created: ${annotationResult.annotationCount}`);
        if (annotationResult.annotatedPdfUrl) {
          console.log(`  Annotated PDF: ${annotationResult.annotatedPdfUrl}`);
        }
        if (annotationResult.errors && annotationResult.errors.length > 0) {
          console.warn(`  Errors: ${annotationResult.errors.join(', ')}`);
        }
      } catch (error) {
        console.error("Annotation generation failed (non-critical):", error);
        // Continue with extraction - annotations are enhancement, not requirement
      }

      // CRITICAL: Fail-fast on characteristic creation failure (no error suppression)
      // FIX #1: Persist ALL AS9102 fields from Gemini extraction
      const createdCharacteristics = await Promise.all(
        sourceCharacteristics.map(async (char: any, index: number) => {
          return await storage.createCharacteristic({
            drawingId: drawing.id,
            balloonNumber: index + 1,
            description: char.description || "Characteristic",
            
            // Numeric fields (nullable for notes/materials/processes)
            specification: char.nominalValue != null ? `${char.nominalValue}` : null,
            tolerancePlus: char.tolerancePlus ?? null,
            toleranceMinus: char.toleranceMinus ?? null,
            unit: char.unit ?? null,
            
            // Inspection config
            inspectionMethod: char.requirementType === "dimension" ? "Caliper" : "Visual",
            sampleSize: 1,
            
            // GD&T (only for dimensions)
            gdtType: char.gdtType || null,
            gdtTolerance: char.gdtTolerance ?? null,
            
            // Classification
            region: char.region, // CRITICAL: Persist classification data
            
            // AS9102 Compliance Fields (FIX #1 - persist these!)
            requirementType: char.requirementType || "dimension",
            characteristicDesignator: char.characteristicDesignator ?? "N/A",
            quantity: char.quantity ?? null,
            surfaceFinish: char.surfaceFinish ?? null,
            passFailExpected: char.passFailExpected ?? null,
          });
        })
      );

      // All characteristics created successfully (or extraction failed fast)
      
      // Backfill annotation characteristicId using extractionKey (index-based matching)
      // This links annotations created during extraction to persisted characteristics
      console.log(`Backfilling ${createdCharacteristics.length} annotation links...`);
      let backfilledCount = 0;
      for (let i = 0; i < createdCharacteristics.length; i++) {
        const char = createdCharacteristics[i];
        const extractionKey = `${i}`; // Same key used during annotation creation
        
        try {
          const result = await db.update(drawingAnnotations)
            .set({ characteristicId: char.id })
            .where(
              and(
                eq(drawingAnnotations.drawingId, drawing.id),
                eq(drawingAnnotations.extractionKey, extractionKey)
              )
            )
            .returning({ id: drawingAnnotations.id });
          
          if (result.length > 0) {
            backfilledCount++;
          }
        } catch (error) {
          console.error(`Failed to backfill annotation for characteristic ${char.id}:`, error);
          // Non-critical: annotation linking is enhancement, continue with extraction
        }
      }
      console.log(`✓ Backfilled ${backfilledCount} annotation-to-characteristic links`);
      
      // CRITICAL AS9102 REQUIREMENT: Ensure page dimensions are valid positive finite numbers
      // Reject null/undefined/0/NaN/Infinity - no silent fallbacks allowed for compliance
      const isValidDimension = (dim: number | null | undefined): dim is number => 
        dim != null && Number.isFinite(dim) && dim > 0;

      if (!isValidDimension(drawing.pageWidth) || !isValidDimension(drawing.pageHeight)) {
        console.error(`Invalid page dimensions for AS9102 zones: width=${drawing.pageWidth}, height=${drawing.pageHeight}`);
        return res.status(422).json({ 
          error: "Valid page dimensions required for AS9102 zone calculation",
          details: `The PDF page dimensions are invalid or missing (width=${drawing.pageWidth}, height=${drawing.pageHeight}). Please ensure the PDF is valid and retry.`
        });
      }

      // Auto-create balloons with intelligent placement next to actual dimensions
      // CRITICAL: Fail-fast on balloon creation failure (no error suppression)
      // Wrap in try-catch to convert zone calculation errors to 422 (not 500)
      console.log(`Creating ${createdCharacteristics.length} balloons with dynamic sizing and intelligent blank-space placement...`);
      let balloons;
      const createdBalloonPositions: Array<{ xPosition: number; yPosition: number; balloonDiameter: number }> = [];
      const allTextItems = firstPage ? firstPage.textItems : [];
      const totalCharacteristics = createdCharacteristics.length;
      
      // Load all annotations for this drawing (for annotation-based balloon anchoring)
      const loadedAnnotations = await storage.getDrawingAnnotations(drawing.id);
      console.log(`Loaded ${loadedAnnotations.length} annotation highlights for balloon anchoring`);
      
      // Calculate balloon size upfront for logging
      const balloonSize = calculateBalloonSize(totalCharacteristics);
      console.log(`Balloon diameter: ${balloonSize}px for ${totalCharacteristics} characteristics`);
      
      try {
        balloons = await Promise.all(
        createdCharacteristics.map(async (createdChar, index) => {
          const sourceChar = sourceCharacteristics[index]; // Get original extraction data
          
          // PRIORITY 1: Use annotation coordinates if available (AI-detected feature location)
          // NOTE: Annotations are linked to characteristics via extractionKey backfill
          let targetPosition: { x: number; y: number; width: number; height: number } | null = null;
          const annotation = loadedAnnotations.find(a => a.characteristicId === createdChar.id);
          
          if (annotation) {
            // Annotation coordinates are already in absolute PDF space (same as balloons)
            targetPosition = {
              x: annotation.x,
              y: annotation.y,
              width: annotation.width,
              height: annotation.height
            };
            console.log(`Balloon #${createdChar.balloonNumber}: Anchoring to ${annotation.annotationType} annotation at (${targetPosition.x.toFixed(0)}, ${targetPosition.y.toFixed(0)})`);
          }
          
          // PRIORITY 2: Fallback to text search if no annotation
          let textPosition: { x: number; y: number; width: number; height: number } | null = null;
          let foundText = false;
          
          if (!targetPosition && firstPage && sourceChar) {
            // For dimensions, search for the nominal value
            if (sourceChar.nominalValue != null) {
              const searchText = sourceChar.nominalValue.toString();
              const textItem = findDimensionTextPosition(firstPage.textItems, searchText);
              
              if (textItem) {
                textPosition = textItem;
                targetPosition = textItem; // Use as target
                foundText = true;
                console.log(`Balloon #${createdChar.balloonNumber}: Found "${searchText}" at (${textItem.x.toFixed(0)}, ${textItem.y.toFixed(0)})`);
              } else {
                console.log(`Balloon #${createdChar.balloonNumber}: Text "${searchText}" not found in PDF`);
              }
            }
            
            // For notes/materials/processes, search for description keywords
            if (!foundText && sourceChar.description) {
              // Try first few words of description
              const keywords = sourceChar.description.split(' ').slice(0, 3).join(' ');
              const textItem = findDimensionTextPosition(firstPage.textItems, keywords);
              
              if (textItem) {
                textPosition = textItem;
                targetPosition = textItem; // Use as target
                foundText = true;
                console.log(`Balloon #${createdChar.balloonNumber}: Found description "${keywords}" at (${textItem.x.toFixed(0)}, ${textItem.y.toFixed(0)})`);
              }
            }
          }
          
          // Use smart placement algorithm with blank space detection
          // Dynamically sizes balloons based on total count
          // Checks collisions with existing balloons AND all text on drawing
          // Uses drawing origin to avoid title blocks and borders
          // NOTE: targetPosition prioritizes annotation coordinates, falls back to text search
          const smartPlacement = computeSmartBalloonPlacement(
            targetPosition,
            createdChar.balloonNumber,
            drawing.pageWidth!,
            drawing.pageHeight!,
            createdBalloonPositions,
            totalCharacteristics,
            allTextItems,
            drawingOrigin
          );
          
          const xPosition = smartPlacement.xPosition;
          const yPosition = smartPlacement.yPosition;
          const balloonSide = smartPlacement.side;
          const balloonDiameter = smartPlacement.balloonDiameter;
          
          // Track balloon position for collision detection with future balloons
          createdBalloonPositions.push({ xPosition, yPosition, balloonDiameter });
          
          // Leader line: Point from balloon to target center (annotation or dimension text)
          let leaderX: number;
          let leaderY: number;
          
          if (targetPosition) {
            // Leader points to center of target (annotation bounding box or text position)
            leaderX = targetPosition.x + targetPosition.width / 2;
            leaderY = targetPosition.y + targetPosition.height / 2;
          } else {
            // Fallback: short leader toward drawing center
            const direction = {
              horizontal: balloonSide === 'left' ? 'right' as const : 'left' as const,
              vertical: 'down' as const
            };
            const centerLeader = computeLeaderOffset(xPosition, yPosition, direction);
            leaderX = centerLeader.leaderX;
            leaderY = centerLeader.leaderY;
          }
          
          // DEFENSIVE: Validate leader distance
          const MIN_LEADER_DISTANCE = 5;
          const deltaX = leaderX - xPosition;
          const deltaY = leaderY - yPosition;
          const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
          
          if (distance < MIN_LEADER_DISTANCE) {
            console.warn(`Balloon #${createdChar.balloonNumber}: Leader too close (${distance.toFixed(1)}px), adjusting...`);
            const direction = {
              horizontal: balloonSide === 'left' ? 'right' as const : 'left' as const,
              vertical: 'down' as const
            };
            const fallback = computeLeaderOffset(xPosition, yPosition, direction);
            leaderX = fallback.leaderX;
            leaderY = fallback.leaderY;
          }

          const balloon = await storage.createBalloon({
            drawingId: drawing.id,
            characteristicId: createdChar.id,
            balloonNumber: createdChar.balloonNumber,
            xPosition: Math.round(xPosition),
            yPosition: Math.round(yPosition),
            leaderX: Math.round(leaderX),
            leaderY: Math.round(leaderY),
          });

          // AS9102 COMPLIANCE: Calculate and persist drawing zone immediately after balloon creation
          const drawingZone = calculateDrawingZone(
            Math.round(xPosition),
            Math.round(yPosition),
            drawing.pageWidth!,
            drawing.pageHeight!
          );
          await db.update(characteristics)
            .set({ drawingZone })
            .where(eq(characteristics.id, createdChar.id));

          return balloon;
        })
      );
      } catch (zoneError: any) {
        // Zone calculation failed (invalid dimensions) - return 422 with clear message
        console.error("Zone calculation failed during extraction:", zoneError);
        return res.status(422).json({
          error: "Zone calculation failed",
          details: zoneError.message || "Invalid page dimensions prevented AS9102 zone calculation"
        });
      }

      // All persistence succeeded (or extraction failed fast)
      
      // Return full classification data for audit trail and downstream use
      res.json({ 
        characteristics: createdCharacteristics, // Return persisted characteristics
        balloons,
        classificationSummary: {
          total: allCharacteristics.length,
          part: partCharacteristics.length,
          template: templateCharacteristics.length,
          uncertain: uncertainCharacteristics.length,
          message: `Successfully extracted ${partCharacteristics.length} characteristics with ${balloons.length} auto-placed balloons`,
          templateCharacteristics: templateCharacteristics.map((char: any) => ({
            description: char.description,
            requirementType: char.requirementType,
            value: char.nominalValue != null ? `${char.nominalValue} ${char.unit || ''}`.trim() : 'N/A',
            reason: "Classified as template element (title block, notes, etc.)"
          })),
          uncertainCharacteristics: uncertainCharacteristics.map((char: any) => ({
            description: char.description,
            requirementType: char.requirementType,
            value: char.nominalValue != null ? `${char.nominalValue} ${char.unit || ''}`.trim() : 'N/A',
            reason: "Classification uncertain - may need manual review"
          })),
        },
        metadata: metadata
      });
    } catch (error) {
      console.error("Extraction error:", error);
      res.status(500).json({ error: "Failed to extract dimensions" });
    }
  });

  // Characteristics
  app.get("/api/characteristics", async (req, res) => {
    try {
      const drawingId = req.query.drawingId as string | undefined;
      const characteristics = await storage.getCharacteristics(drawingId);
      res.json(characteristics);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch characteristics" });
    }
  });

  app.post("/api/characteristics", async (req, res) => {
    try {
      // Check if this is a manual creation (no balloonNumber provided) or AI extraction
      const isManualCreation = !req.body.balloonNumber;
      
      if (isManualCreation) {
        // Parse with manual schema (no balloonNumber required)
        const manualData = manualCharacteristicInputSchema.parse(req.body);
        
        // Compute next balloon number (transaction-safe in future)
        const existingChars = await storage.getCharacteristics(manualData.drawingId);
        const validBalloonNumbers = existingChars
          .map(c => c.balloonNumber)
          .filter(num => typeof num === 'number' && !isNaN(num));
        const nextBalloonNumber = validBalloonNumbers.length > 0
          ? Math.max(...validBalloonNumbers) + 1
          : 1;
        
        // Build fully-typed InsertCharacteristic with balloonNumber
        const fullData: InsertCharacteristic = {
          ...manualData,
          balloonNumber: nextBalloonNumber,
        };
        
        const characteristic = await storage.createCharacteristic(fullData);
        res.json(characteristic);
      } else {
        // AI extraction provides balloonNumber
        const data = insertCharacteristicSchema.parse(req.body);
        const characteristic = await storage.createCharacteristic(data);
        res.json(characteristic);
      }
    } catch (error) {
      res.status(400).json({ error: "Invalid characteristic data" });
    }
  });

  // Balloons
  app.get("/api/balloons", async (req, res) => {
    try {
      const drawingId = req.query.drawingId as string | undefined;
      const balloons = await storage.getBalloons(drawingId);
      
      const enrichedBalloons = await Promise.all(
        balloons.map(async (balloon) => {
          const characteristic = await storage.getCharacteristic(balloon.characteristicId);
          return {
            ...balloon,
            characteristic: characteristic || null,
          };
        })
      );
      
      res.json(enrichedBalloons);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch balloons" });
    }
  });

  app.post("/api/balloons", async (req, res) => {
    try {
      const data = insertBalloonSchema.parse(req.body);
      
      const characteristic = await storage.getCharacteristic(data.characteristicId);
      if (!characteristic) {
        return res.status(404).json({ error: "Characteristic not found" });
      }
      
      if (characteristic.drawingId !== data.drawingId) {
        return res.status(400).json({ error: "Characteristic does not belong to this drawing" });
      }
      
      const existingBalloons = await storage.getBalloons(data.drawingId);
      const duplicateBalloon = existingBalloons.find(b => b.characteristicId === data.characteristicId);
      if (duplicateBalloon) {
        return res.status(400).json({ error: "This characteristic already has a balloon" });
      }
      
      // ALWAYS compute leader coordinates server-side for manual placements
      // computeLeaderOffset() GUARANTEES distance ≥ 5px
      const { leaderX, leaderY } = computeLeaderOffset(data.xPosition, data.yPosition);
      
      // Calculate AS9102-compliant drawing zone (e.g., "A-2", "D-3")
      const drawing = await storage.getDrawing(data.drawingId);
      let drawingZone: string | undefined;
      if (drawing && drawing.pageWidth && drawing.pageHeight) {
        try {
          drawingZone = calculateDrawingZone(
            data.xPosition,
            data.yPosition,
            drawing.pageWidth,
            drawing.pageHeight
          );
          // Update characteristic with calculated zone
          await db.update(characteristics)
            .set({ drawingZone })
            .where(eq(characteristics.id, data.characteristicId));
        } catch (zoneError: any) {
          // Zone calculation failed due to invalid dimensions
          console.error("Zone calculation failed:", zoneError);
          return res.status(422).json({ 
            error: "Zone calculation failed", 
            details: zoneError.message || "Invalid page dimensions prevented AS9102 zone calculation"
          });
        }
      }
      
      const balloon = await storage.createBalloon({
        drawingId: data.drawingId,
        balloonNumber: data.balloonNumber,
        characteristicId: data.characteristicId,
        xPosition: data.xPosition,
        yPosition: data.yPosition,
        leaderX,
        leaderY,
      });
      res.json(balloon);
    } catch (error: any) {
      console.error("Balloon creation error:", error);
      res.status(400).json({ error: error.message || "Invalid balloon data" });
    }
  });

  app.patch("/api/balloons/reorder", async (req, res) => {
    try {
      const { balloon1Id, balloon2Id } = req.body;
      
      const allBalloons = await storage.getBalloons();
      const balloon1 = allBalloons.find(b => b.id === balloon1Id);
      const balloon2 = allBalloons.find(b => b.id === balloon2Id);
      
      if (!balloon1 || !balloon2) {
        return res.status(404).json({ error: "Balloons not found" });
      }
      
      const num1 = balloon1.balloonNumber;
      const num2 = balloon2.balloonNumber;
      
      await storage.updateBalloonNumber(balloon1.id, num2);
      await storage.updateBalloonNumber(balloon2.id, num1);
      
      await storage.updateCharacteristicBalloonNumber(balloon1.characteristicId, num2);
      await storage.updateCharacteristicBalloonNumber(balloon2.characteristicId, num1);
      
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: "Failed to reorder balloons" });
    }
  });

  // Inspections
  app.post("/api/inspections/batch", async (req, res) => {
    try {
      const { inspections } = req.body;
      
      // Process each inspection with validation and computation
      const created = await Promise.all(
        inspections.map(async (inspectionData: any) => {
          // Validate with XOR schema
          const validated = insertInspectionSchema.parse(inspectionData);
          
          // Fetch characteristic to check type and compute passed flag
          const characteristic = await storage.getCharacteristic(validated.characteristicId);
          if (!characteristic) {
            throw new Error(`Characteristic ${validated.characteristicId} not found`);
          }
          
          let passed: boolean;
          let normalizedPassFail: string | null = null;
          
          // Use local constants for type narrowing
          const actualValue = validated.actualValue;
          const passFailResult = validated.passFailResult;
          
          // Determine result type and compute passed flag
          if (actualValue != null) {
            // Numeric inspection: check tolerance
            if (characteristic.passFailExpected) {
              throw new Error(`Characteristic "${characteristic.description}" expects pass/fail result, not numeric value`);
            }
            
            // Compute passed from tolerance with safe parsing
            const specStr = characteristic.specification;
            if (!specStr) {
              throw new Error(`Characteristic "${characteristic.description}" has no specification value for tolerance checking`);
            }
            
            const nominal = Number.parseFloat(specStr);
            if (Number.isNaN(nominal)) {
              throw new Error(`Invalid specification value: "${specStr}"`);
            }
            
            const tolerancePlus = characteristic.tolerancePlus ?? 0;
            const toleranceMinus = characteristic.toleranceMinus ?? 0;
            
            const upperLimit = nominal + tolerancePlus;
            const lowerLimit = nominal - toleranceMinus;
            
            passed = actualValue >= lowerLimit && actualValue <= upperLimit;
          } else if (passFailResult != null && passFailResult.trim() !== "") {
            // Pass/fail inspection: normalize and validate
            if (characteristic.requirementType === "dimension" && !characteristic.passFailExpected) {
              throw new Error(`Characteristic "${characteristic.description}" requires numeric measurement, not pass/fail`);
            }
            
            // Normalize pass/fail string
            passed = normalizePassFail(passFailResult);
            normalizedPassFail = passFailResult.toUpperCase().trim();
          } else {
            throw new Error("Neither actualValue nor passFailResult provided");
          }
          
          // Create inspection with computed passed flag
          return await storage.createInspection({
            ...validated,
            passed,
            passFailResult: normalizedPassFail,
          });
        })
      );
      
      res.json(created);
    } catch (error) {
      console.error("Batch inspection error:", error);
      const message = error instanceof Error ? error.message : "Failed to submit inspections";
      res.status(400).json({ error: message });
    }
  });

  // Reports
  app.get("/api/reports", async (req, res) => {
    try {
      const projectId = req.query.projectId as string | undefined;
      const reports = await storage.getReports(projectId);
      res.json(reports);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch reports" });
    }
  });

  app.post("/api/reports/generate", async (req, res) => {
    try {
      const { projectId, drawingId } = req.body;
      
      const project = await storage.getProject(projectId);
      const drawing = await storage.getDrawing(drawingId);
      const characteristics = await storage.getCharacteristics(drawingId);
      const inspections = await storage.getInspections(drawingId);
      
      if (!project || !drawing) {
        return res.status(404).json({ error: "Project or drawing not found" });
      }

      const doc = new jsPDF({ orientation: "landscape", format: "a4" });
      
      // Header
      doc.setFontSize(14);
      doc.text("AS9102 Rev C - FIRST ARTICLE INSPECTION REPORT", 148, 15, { align: "center" });
      doc.setFontSize(10);
      doc.text("FORM 3 - CHARACTERISTIC ACCOUNTABILITY, VERIFICATION, AND EVALUATION", 148, 22, { align: "center" });
      
      // Part Info Header
      doc.setFontSize(9);
      doc.text(`Part Number: ${project.partNumber}`, 10, 30);
      doc.text(`Part Name: ${project.name}`, 10, 36);
      doc.text(`Drawing: ${drawing.name}`, 10, 42);
      doc.text(`Date: ${new Date().toLocaleDateString()}`, 220, 30);
      doc.text(`Page: 1 of 1`, 220, 36);

      // Table headers - AS9102 Rev C compliant
      let yPos = 50;
      const rowHeight = 7;
      const colWidths = {
        balloon: 12,
        zone: 15,
        designator: 20,
        qty: 12,
        description: 50,
        specification: 35,
        result: 25,
        status: 18,
      };
      
      let xPos = 10;
      doc.setFontSize(7);
      doc.setFont("helvetica", "bold");
      
      // Header row
      doc.rect(xPos, yPos, colWidths.balloon, rowHeight);
      doc.text("#", xPos + 4, yPos + 5);
      xPos += colWidths.balloon;
      
      doc.rect(xPos, yPos, colWidths.zone, rowHeight);
      doc.text("Zone", xPos + 2, yPos + 5);
      doc.text("(Box 6)", xPos + 1, yPos + 5.5);
      xPos += colWidths.zone;
      
      doc.rect(xPos, yPos, colWidths.designator, rowHeight);
      doc.text("Designator", xPos + 2, yPos + 5);
      doc.text("(Box 7)", xPos + 2, yPos + 5.5);
      xPos += colWidths.designator;
      
      doc.rect(xPos, yPos, colWidths.qty, rowHeight);
      doc.text("Qty", xPos + 3, yPos + 5);
      xPos += colWidths.qty;
      
      doc.rect(xPos, yPos, colWidths.description, rowHeight);
      doc.text("Characteristic Description", xPos + 2, yPos + 5);
      xPos += colWidths.description;
      
      doc.rect(xPos, yPos, colWidths.specification, rowHeight);
      doc.text("Specification/Tolerance", xPos + 2, yPos + 5);
      xPos += colWidths.specification;
      
      doc.rect(xPos, yPos, colWidths.result, rowHeight);
      doc.text("Actual Result", xPos + 2, yPos + 5);
      xPos += colWidths.result;
      
      doc.rect(xPos, yPos, colWidths.status, rowHeight);
      doc.text("Status", xPos + 4, yPos + 5);
      
      yPos += rowHeight;
      doc.setFont("helvetica", "normal");

      // Data rows
      characteristics.forEach((char) => {
        if (yPos > 190) {
          doc.addPage();
          yPos = 20;
        }

        const inspection = inspections.find(i => i.characteristicId === char.id);
        xPos = 10;
        
        // Balloon Number
        doc.rect(xPos, yPos, colWidths.balloon, rowHeight);
        doc.text(String(char.balloonNumber), xPos + 4, yPos + 5);
        xPos += colWidths.balloon;
        
        // Zone (Box 6)
        doc.rect(xPos, yPos, colWidths.zone, rowHeight);
        doc.text(char.drawingZone || "N/A", xPos + 2, yPos + 5);
        xPos += colWidths.zone;
        
        // Characteristic Designator (Box 7)
        doc.rect(xPos, yPos, colWidths.designator, rowHeight);
        const designator = char.characteristicDesignator || "N/A";
        doc.text(designator, xPos + 2, yPos + 5);
        xPos += colWidths.designator;
        
        // Quantity
        doc.rect(xPos, yPos, colWidths.qty, rowHeight);
        doc.text(char.quantity || "1", xPos + 3, yPos + 5);
        xPos += colWidths.qty;
        
        // Description with requirement type indicator
        doc.rect(xPos, yPos, colWidths.description, rowHeight);
        let desc = char.description;
        if (char.requirementType && char.requirementType !== "dimension") {
          desc = `[${char.requirementType.toUpperCase()}] ${desc}`;
        }
        if (char.surfaceFinish) {
          desc = `${desc} - ${char.surfaceFinish}`;
        }
        const descLines = doc.splitTextToSize(desc, colWidths.description - 4);
        doc.text(descLines[0], xPos + 2, yPos + 5);
        xPos += colWidths.description;
        
        // Specification/Tolerance
        doc.rect(xPos, yPos, colWidths.specification, rowHeight);
        let spec = "";
        if (char.specification) {
          spec = char.specification;
          if (char.tolerancePlus !== null && char.toleranceMinus !== null) {
            spec += ` +${char.tolerancePlus}/-${char.toleranceMinus}`;
          }
          if (char.unit) {
            spec += ` ${char.unit}`;
          }
        } else if (char.gdtType) {
          spec = `${char.gdtType} ${char.gdtTolerance || ""}`;
        } else if (char.passFailExpected) {
          spec = `Expected: ${char.passFailExpected}`;
        }
        const specLines = doc.splitTextToSize(spec, colWidths.specification - 4);
        doc.text(specLines[0] || "N/A", xPos + 2, yPos + 5);
        xPos += colWidths.specification;
        
        // Actual Result
        doc.rect(xPos, yPos, colWidths.result, rowHeight);
        let result = "Not Inspected";
        if (inspection) {
          if (inspection.actualValue !== null) {
            result = `${inspection.actualValue}${char.unit ? ` ${char.unit}` : ""}`;
          } else if (inspection.passFailResult) {
            result = inspection.passFailResult;
          }
        }
        doc.text(result, xPos + 2, yPos + 5);
        xPos += colWidths.result;
        
        // Status (Pass/Fail)
        doc.rect(xPos, yPos, colWidths.status, rowHeight);
        let status = "N/A";
        if (inspection) {
          status = inspection.passed ? "PASS" : "FAIL";
          if (inspection.passed) {
            doc.setTextColor(0, 128, 0); // Green
          } else {
            doc.setTextColor(255, 0, 0); // Red
          }
        }
        doc.text(status, xPos + 4, yPos + 5);
        doc.setTextColor(0, 0, 0); // Reset to black
        
        yPos += rowHeight;
      });

      // Footer notes
      yPos += 10;
      doc.setFontSize(8);
      doc.text("Box 6 (Zone): Drawing zone reference (e.g., A-2, D-3) based on balloon position", 10, yPos);
      doc.text("Box 7 (Designator): Critical, Key, Major, Minor, or N/A", 10, yPos + 5);
      doc.text("Qty: Quantity notation for multiple instances (e.g., 4X, 2X)", 10, yPos + 10);

      const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
      const uploadURL = await objectStorageService.getUploadURL(`report-${Date.now()}.pdf`);
      
      await fetch(uploadURL, {
        method: "PUT",
        body: pdfBuffer,
        headers: {
          "Content-Type": "application/pdf",
        },
      });

      const pdfUrl = uploadURL.split("?")[0];

      const report = await storage.createReport({
        projectId,
        drawingId,
        reportType: "AS9102 Form 3",
        pdfUrl,
        generatedBy: "System",
      });

      res.json(report);
    } catch (error) {
      console.error("Report generation error:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  // Filtered Dimensions (audit trail for template/uncertain classifications)
  app.get("/api/filtered-dimensions", async (req, res) => {
    try {
      const drawingId = req.query.drawingId as string;
      if (!drawingId) {
        return res.status(400).json({ error: "drawingId is required" });
      }
      const filteredDims = await storage.getFilteredDimensions(drawingId);
      res.json(filteredDims);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch filtered dimensions" });
    }
  });

  app.get("/api/filtered-dimensions/all", async (req, res) => {
    try {
      const filteredDims = await storage.getAllFilteredDimensions();
      res.json(filteredDims);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch all filtered dimensions" });
    }
  });

  // Stats for dashboard
  app.get("/api/stats", async (_req, res) => {
    try {
      const allInspections = await storage.getInspections();
      const totalInspections = allInspections.length;
      const passedInspections = allInspections.filter((i) => i.passed).length;
      const failedInspections = totalInspections - passedInspections;
      const passRate = totalInspections > 0 
        ? Math.round((passedInspections / totalInspections) * 100) 
        : 0;

      res.json({
        totalInspections,
        passedInspections,
        failedInspections,
        pendingReviews: 0,
        passRate,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  app.get("/api/stats/chart", async (_req, res) => {
    try {
      const characteristics = await storage.getCharacteristics();
      const chartData = [];

      for (const char of characteristics.slice(0, 10)) {
        const inspections = await storage.getInspections(char.id);
        const passed = inspections.filter((i) => i.passed).length;
        const failed = inspections.length - passed;
        
        chartData.push({
          name: `#${char.balloonNumber}`,
          passed,
          failed,
        });
      }

      res.json(chartData);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch chart data" });
    }
  });

  // Equipment Management (LM FAI Compliance)
  app.get("/api/equipment", async (req, res) => {
    try {
      const { projectId } = req.query;
      const equipment = await storage.getEquipment(projectId as string);
      res.json(equipment);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch equipment" });
    }
  });

  app.get("/api/equipment/:id", async (req, res) => {
    try {
      const equipment = await storage.getEquipmentById(req.params.id);
      if (!equipment) {
        return res.status(404).json({ error: "Equipment not found" });
      }
      res.json(equipment);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch equipment" });
    }
  });

  app.post("/api/equipment", async (req, res) => {
    try {
      const data = insertEquipmentSchema.parse(req.body);
      const equipment = await storage.createEquipment(data);
      res.json(equipment);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ error: "Invalid equipment data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create equipment" });
    }
  });

  app.put("/api/equipment/:id", async (req, res) => {
    try {
      // Allow empty body for PATCH semantics - storage layer will handle no-op
      const data = Object.keys(req.body).length > 0
        ? insertEquipmentSchema.partial().parse(req.body)
        : {};
      const equipment = await storage.updateEquipment(req.params.id, data);
      res.json(equipment);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ error: "Invalid equipment update data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to update equipment" });
    }
  });

  app.delete("/api/equipment/:id", async (req, res) => {
    try {
      await storage.deleteEquipment(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete equipment" });
    }
  });

  // Inspector Management (LM FAI Compliance)
  app.get("/api/inspectors", async (req, res) => {
    try {
      const { projectId } = req.query;
      const inspectors = await storage.getInspectors(projectId as string);
      res.json(inspectors);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch inspectors" });
    }
  });

  app.get("/api/inspectors/:id", async (req, res) => {
    try {
      const inspector = await storage.getInspectorById(req.params.id);
      if (!inspector) {
        return res.status(404).json({ error: "Inspector not found" });
      }
      res.json(inspector);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch inspector" });
    }
  });

  app.post("/api/inspectors", async (req, res) => {
    try {
      const data = insertInspectorSchema.parse(req.body);
      const inspector = await storage.createInspector(data);
      res.json(inspector);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ error: "Invalid inspector data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to create inspector" });
    }
  });

  app.put("/api/inspectors/:id", async (req, res) => {
    try {
      // Allow empty body for PATCH semantics - storage layer will handle no-op
      const data = Object.keys(req.body).length > 0
        ? insertInspectorSchema.partial().parse(req.body)
        : {};
      const inspector = await storage.updateInspector(req.params.id, data);
      res.json(inspector);
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({ error: "Invalid inspector update data", details: error.errors });
      }
      res.status(500).json({ error: "Failed to update inspector" });
    }
  });

  app.delete("/api/inspectors/:id", async (req, res) => {
    try {
      await storage.deleteInspector(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete inspector" });
    }
  });

  // Download annotation code files as JSON bundle for experimentation
  app.get("/api/download-annotation-code", async (req, res) => {
    try {
      const fs = await import('fs').then(m => m.promises);
      
      const files = [
        { name: 'viewer.tsx', path: 'client/src/pages/viewer.tsx' },
        { name: 'routes.ts', path: 'server/routes.ts' },
        { name: 'annotationGenerator.ts', path: 'server/annotationGenerator.ts' },
        { name: 'textMatcher.ts', path: 'server/textMatcher.ts' },
        { name: 'pdfAnnotator.ts', path: 'server/pdfAnnotator.ts' },
        { name: 'schema.ts', path: 'shared/schema.ts' },
      ];
      
      const bundle: Record<string, string> = {};
      for (const file of files) {
        bundle[file.name] = await fs.readFile(file.path, 'utf-8');
      }
      
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="annotation_code.json"');
      res.json(bundle);
    } catch (error) {
      console.error('Download error:', error);
      res.status(500).json({ error: 'Failed to bundle files' });
    }
  });

  // Upload annotation code files to GitHub
  app.post("/api/upload-to-github", async (req, res) => {
    try {
      const fs = await import('fs').then(m => m.promises);
      const { uploadFilesToGitHub } = await import('./githubClient');
      
      const repoName = req.body.repoName || 'REPLIT-FAI';
      
      const filePaths = [
        { name: 'client/viewer.tsx', path: 'client/src/pages/viewer.tsx' },
        { name: 'server/routes.ts', path: 'server/routes.ts' },
        { name: 'server/annotationGenerator.ts', path: 'server/annotationGenerator.ts' },
        { name: 'server/textMatcher.ts', path: 'server/textMatcher.ts' },
        { name: 'server/pdfAnnotator.ts', path: 'server/pdfAnnotator.ts' },
        { name: 'shared/schema.ts', path: 'shared/schema.ts' },
      ];
      
      const files = await Promise.all(
        filePaths.map(async (f) => ({
          path: f.name,
          content: await fs.readFile(f.path, 'utf-8'),
        }))
      );
      
      const repoUrl = await uploadFilesToGitHub(repoName, files);
      res.json({ success: true, repoUrl });
    } catch (error: any) {
      console.error('GitHub upload error:', error);
      res.status(500).json({ error: error.message || 'Failed to upload to GitHub' });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
