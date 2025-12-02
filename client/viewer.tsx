import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Document, Page, pdfjs } from "react-pdf";
import {
  ZoomIn,
  ZoomOut,
  Move,
  Circle,
  Upload,
  Sparkles,
  ChevronUp,
  ChevronDown,
  Plus,
  Eye,
  EyeOff,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  type Drawing,
  type Balloon,
  type Characteristic,
  type DrawingAnnotation,
} from "@shared/schema";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

type BalloonWithCharacteristic = Balloon & {
  characteristic: Characteristic | null;
};

export default function Viewer() {
  const { toast } = useToast();
  const params = new URLSearchParams(window.location.search);
  const projectId = params.get("projectId");

  const [scale, setScale] = useState(1);
  const [tool, setTool] = useState<"pan" | "balloon">("pan");
  const [numPages, setNumPages] = useState<number>(0);
  const [activePage, setActivePage] = useState(1); // Current page being viewed (1-indexed)
  const [selectedDrawing, setSelectedDrawing] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number }>({
    width: 842,
    height: 595,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const pageProxyRef = useRef<any>(null); // Cache PDFPageProxy for viewport transforms
  const [formData, setFormData] = useState({
    description: "",
    specification: "",
    tolerancePlus: "0",
    toleranceMinus: "0",
    unit: "mm",
    inspectionMethod: "Caliper",
    sampleSize: "1",
    gdtType: "",
    gdtTolerance: "",
    // AS9102 Rev C fields
    characteristicDesignator: "N/A",
    quantity: "1",
    surfaceFinish: "",
    requirementType: "dimension",
    passFailExpected: "",
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: drawings, isLoading: drawingsLoading } = useQuery<Drawing[]>({
    queryKey: [`/api/drawings?projectId=${projectId}`],
    enabled: !!projectId,
    refetchOnMount: "always",
    staleTime: 0,
  });

  const { data: characteristics, isSuccess: characteristicsLoaded } = useQuery<
    Characteristic[]
  >({
    queryKey: [`/api/characteristics?drawingId=${selectedDrawing}`],
    enabled: !!selectedDrawing,
  });

  const { data: savedBalloons } = useQuery<BalloonWithCharacteristic[]>({
    queryKey: [`/api/balloons?drawingId=${selectedDrawing}`],
    enabled: !!selectedDrawing,
  });

  const { data: annotations } = useQuery<DrawingAnnotation[]>({
    queryKey: ["/api/drawings", selectedDrawing, "annotations"],
    enabled: !!selectedDrawing && showAnnotations,
  });

  const createBalloonMutation = useMutation({
    mutationFn: async (balloon: {
      characteristicId: string;
      drawingId: string;
      balloonNumber: number;
      xPosition: number;
      yPosition: number;
    }) => {
      // Leader coordinates are computed server-side only
      return await apiRequest("POST", "/api/balloons", balloon);
    },
    onSuccess: () => {
      // Invalidate to refetch balloons with server-computed leader coordinates
      queryClient.invalidateQueries({
        queryKey: [`/api/balloons?drawingId=${selectedDrawing}`],
      });
      toast({
        title: "Balloon placed",
        description: "Balloon added to drawing",
      });
    },
  });

  const extractMutation = useMutation({
    mutationFn: async (drawingId: string) => {
      return await apiRequest("POST", "/api/drawings/extract", { drawingId });
    },
    onSuccess: (data: any, drawingId) => {
      queryClient.invalidateQueries({
        queryKey: [`/api/characteristics?drawingId=${drawingId}`],
      });
      queryClient.invalidateQueries({
        queryKey: [`/api/balloons?drawingId=${drawingId}`],
      });

      const summary = data?.classificationSummary;
      if (summary) {
        if (summary.part === 0) {
          // No part dimensions found - show informative message
          toast({
            title: "AI Extraction Complete",
            description:
              summary.message ||
              `No part dimensions found. Classified ${summary.template} template and ${summary.uncertain} uncertain elements. Audit trail saved.`,
            duration: 7000, // Longer duration for important message
          });
        } else {
          // Found part dimensions - show success
          toast({
            title: "AI Extraction Complete",
            description: `Found ${summary.part} part dimension${summary.part !== 1 ? "s" : ""}. Filtered ${summary.template} template and ${summary.uncertain} uncertain elements.`,
          });
        }
      } else {
        // Fallback for backwards compatibility
        toast({
          title: "AI extraction completed",
          description: "Dimensions and GD&T features extracted successfully",
        });
      }
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async ({
      balloon1Id,
      balloon2Id,
    }: {
      balloon1Id: string;
      balloon2Id: string;
    }) => {
      return await apiRequest("PATCH", "/api/balloons/reorder", {
        balloon1Id,
        balloon2Id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/balloons?drawingId=${selectedDrawing}`],
      });
      queryClient.invalidateQueries({
        queryKey: [`/api/characteristics?drawingId=${selectedDrawing}`],
      });
    },
  });

  const createCharacteristicMutation = useMutation({
    mutationFn: async (data: any) => {
      if (!selectedDrawing) throw new Error("No drawing selected");
      // Backend auto-assigns balloon number (transaction-safe, no race conditions)
      return await apiRequest("POST", "/api/characteristics", {
        ...data,
        drawingId: selectedDrawing,
        region: "part",
        // balloonNumber is omitted - backend will auto-assign
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/characteristics?drawingId=${selectedDrawing}`],
      });
      setDialogOpen(false);
      setFormData({
        description: "",
        specification: "",
        tolerancePlus: "0",
        toleranceMinus: "0",
        unit: "mm",
        inspectionMethod: "Caliper",
        sampleSize: "1",
        gdtType: "",
        gdtTolerance: "",
        // AS9102 Rev C fields
        characteristicDesignator: "N/A",
        quantity: "1",
        surfaceFinish: "",
        requirementType: "dimension",
        passFailExpected: "",
      });
      toast({
        title: "Characteristic created",
        description: "Manual characteristic added successfully",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to create characteristic",
        description: error?.message || "An error occurred. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (
      tool !== "balloon" ||
      !selectedDrawing ||
      !characteristics ||
      characteristics.length === 0
    ) {
      if (!characteristics || characteristics.length === 0) {
        toast({
          title: "No characteristics",
          description: "Run AI extraction first to create characteristics",
          variant: "destructive",
        });
      }
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    const balloonedCharacteristicIds = new Set(
      savedBalloons?.map((b) => b.characteristicId) || [],
    );
    const unballoonedCharacteristic = characteristics
      .sort((a, b) => a.balloonNumber - b.balloonNumber)
      .find((c) => !balloonedCharacteristicIds.has(c.id));

    if (!unballoonedCharacteristic) {
      toast({
        title: "All characteristics ballooned",
        description: "All characteristics already have balloons placed",
        variant: "destructive",
      });
      return;
    }

    const balloonNumber = unballoonedCharacteristic.balloonNumber;

    // Backend will compute appropriate leader coordinates (omit leaderX/leaderY)
    createBalloonMutation.mutate({
      characteristicId: unballoonedCharacteristic.id,
      drawingId: selectedDrawing,
      balloonNumber,
      xPosition: x,
      yPosition: y,
    });
  };

  // Color map for annotation types
  const getAnnotationColor = (type: string): string => {
    switch (type) {
      case "dimension":
        return "rgba(59, 130, 246, 0.25)"; // Blue
      case "gdt":
        return "rgba(34, 197, 94, 0.25)"; // Green
      case "material":
        return "rgba(234, 179, 8, 0.25)"; // Yellow
      case "process":
        return "rgba(249, 115, 22, 0.25)"; // Orange
      case "note":
        return "rgba(168, 85, 247, 0.25)"; // Purple
      case "functional_test":
        return "rgba(239, 68, 68, 0.25)"; // Red
      default:
        return "rgba(156, 163, 175, 0.25)"; // Gray
    }
  };

  const drawAnnotations = (ctx: CanvasRenderingContext2D) => {
    if (!showAnnotations || !annotations || annotations.length === 0) return;
    if (!pageProxyRef.current) return; // Need page proxy for viewport transform

    // Filter annotations for current page (activePage is 1-indexed, annotation.page is 0-indexed)
    const currentPageAnnotations = annotations.filter(
      (a) => a.page === activePage - 1,
    );

    // Get viewport for coordinate transformation
    const viewport = pageProxyRef.current.getViewport({ scale });

    currentPageAnnotations.forEach((annotation) => {
      // Convert PDF coordinates (lower-left origin, unscaled) to viewport coordinates
      // PDF.js uses [x1, y1, x2, y2] format for rectangles
      const pdfRect = [
        annotation.x,
        annotation.y,
        annotation.x + annotation.width,
        annotation.y + annotation.height,
      ];

      // Transform to viewport space (accounts for scale, rotation, crop boxes)
      const [vx1, vy1, vx2, vy2] = viewport.convertToViewportRectangle(pdfRect);

      // Calculate final dimensions
      const x = Math.min(vx1, vx2);
      const y = Math.min(vy1, vy2);
      const width = Math.abs(vx2 - vx1);
      const height = Math.abs(vy2 - vy1);

      // Draw highlight rectangle
      ctx.fillStyle = getAnnotationColor(annotation.annotationType);
      ctx.fillRect(x, y, width, height);

      // Draw border
      ctx.strokeStyle = getAnnotationColor(annotation.annotationType).replace(
        "0.25",
        "0.6",
      );
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, width, height);
    });
  };

  const drawBalloons = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw annotations first (underneath balloons)
    drawAnnotations(ctx);

    // Use only saved balloons with server-computed leader coordinates
    const balloonData = (savedBalloons || []).map((b) => ({
      x: b.xPosition,
      y: b.yPosition,
      leaderX: b.leaderX,
      leaderY: b.leaderY,
      number: b.balloonNumber,
    }));

    balloonData.forEach((balloon) => {
      const x = balloon.x * scale;
      const y = balloon.y * scale;
      const leaderX = balloon.leaderX * scale;
      const leaderY = balloon.leaderY * scale;
      // Smaller balloon that scales with zoom (12px base, scales with zoom)
      const radius = 12 * Math.min(scale, 1.2); // Cap scaling at 1.2x for very zoomed views
      const fontSize = Math.floor(10 * Math.min(scale, 1.2)); // Scale font with balloon

      // Draw leader line from balloon to dimension
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(leaderX, leaderY);
      ctx.strokeStyle = "hsl(217 91% 42%)";
      ctx.lineWidth = 1.2 * Math.min(scale, 1); // Thinner leader line
      ctx.stroke();

      // Draw balloon circle
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = "white";
      ctx.fill();
      ctx.strokeStyle = "hsl(217 91% 42%)";
      ctx.lineWidth = 1.5 * Math.min(scale, 1.2); // Scale border with balloon
      ctx.stroke();

      // Draw balloon number
      ctx.fillStyle = "hsl(217 91% 42%)";
      ctx.font = `bold ${fontSize}px IBM Plex Sans`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(balloon.number.toString(), x, y);
    });
  };

  useEffect(() => {
    drawBalloons();
  }, [scale, savedBalloons, showAnnotations, annotations, activePage]);

  useEffect(() => {
    if (drawings && drawings.length > 0 && !selectedDrawing) {
      setSelectedDrawing(drawings[0].id);
    }
  }, [drawings, selectedDrawing]);

  const selectedPdf = drawings?.find((d) => d.id === selectedDrawing);

  return (
    <div className="flex h-screen" data-testid="page-viewer">
      <div className="flex-1 flex flex-col">
        <div className="border-b p-3 flex items-center gap-2 bg-card">
          <div className="flex items-center gap-1 border-r pr-2">
            <Button
              size="icon"
              variant={tool === "pan" ? "default" : "ghost"}
              onClick={() => setTool("pan")}
              data-testid="button-pan-tool"
            >
              <Move className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant={tool === "balloon" ? "default" : "ghost"}
              onClick={() => setTool("balloon")}
              data-testid="button-balloon-tool"
            >
              <Circle className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}
              data-testid="button-zoom-out"
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span className="text-sm font-mono w-16 text-center">
              {Math.round(scale * 100)}%
            </span>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setScale((s) => Math.min(3, s + 0.1))}
              data-testid="button-zoom-in"
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>
          <Separator orientation="vertical" className="h-6 mx-2" />
          <Button
            size="icon"
            variant={showAnnotations ? "default" : "ghost"}
            onClick={() => setShowAnnotations(!showAnnotations)}
            title="Toggle AI annotation highlights"
            data-testid="button-toggle-annotations"
          >
            {showAnnotations ? (
              <Eye className="h-4 w-4" />
            ) : (
              <EyeOff className="h-4 w-4" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              const link = document.createElement('a');
              link.href = '/api/download-annotation-code';
              link.download = 'annotation_code.json';
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
            }}
            title="Download annotation code files"
            data-testid="button-download-code"
          >
            <Download className="h-4 w-4" />
          </Button>
          {selectedDrawing && (
            <>
              <Separator orientation="vertical" className="h-6 mx-2" />
              <Button
                size="sm"
                onClick={() => extractMutation.mutate(selectedDrawing)}
                disabled={extractMutation.isPending}
                data-testid="button-extract-features"
              >
                <Sparkles className="h-3 w-3 mr-2" />
                {extractMutation.isPending
                  ? "Extracting..."
                  : "AI Extract Features"}
              </Button>
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="button-add-characteristic"
                  >
                    <Plus className="h-3 w-3 mr-2" />
                    Add Characteristic
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Add Manual Characteristic</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="description">Description</Label>
                        <Input
                          id="description"
                          placeholder="e.g., Hole diameter"
                          value={formData.description}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              description: e.target.value,
                            })
                          }
                          data-testid="input-description"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="specification">Nominal Value</Label>
                        <Input
                          id="specification"
                          placeholder="e.g., 10.5"
                          value={formData.specification}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              specification: e.target.value,
                            })
                          }
                          data-testid="input-specification"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="tolerancePlus">Tolerance +</Label>
                        <Input
                          id="tolerancePlus"
                          type="number"
                          step="0.001"
                          value={formData.tolerancePlus}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              tolerancePlus: e.target.value,
                            })
                          }
                          data-testid="input-tolerance-plus"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="toleranceMinus">Tolerance -</Label>
                        <Input
                          id="toleranceMinus"
                          type="number"
                          step="0.001"
                          value={formData.toleranceMinus}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              toleranceMinus: e.target.value,
                            })
                          }
                          data-testid="input-tolerance-minus"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="unit">Unit</Label>
                        <Select
                          value={formData.unit}
                          onValueChange={(value) =>
                            setFormData({ ...formData, unit: value })
                          }
                        >
                          <SelectTrigger id="unit" data-testid="select-unit">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="mm">mm</SelectItem>
                            <SelectItem value="in">in</SelectItem>
                            <SelectItem value="cm">cm</SelectItem>
                            <SelectItem value="deg">deg</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="inspectionMethod">
                          Inspection Method
                        </Label>
                        <Select
                          value={formData.inspectionMethod}
                          onValueChange={(value) =>
                            setFormData({
                              ...formData,
                              inspectionMethod: value,
                            })
                          }
                        >
                          <SelectTrigger
                            id="inspectionMethod"
                            data-testid="select-inspection-method"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Caliper">Caliper</SelectItem>
                            <SelectItem value="Micrometer">
                              Micrometer
                            </SelectItem>
                            <SelectItem value="CMM">CMM</SelectItem>
                            <SelectItem value="Gauge">Gauge</SelectItem>
                            <SelectItem value="Visual">Visual</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="sampleSize">Sample Size</Label>
                        <Input
                          id="sampleSize"
                          type="number"
                          min="1"
                          value={formData.sampleSize}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              sampleSize: e.target.value,
                            })
                          }
                          data-testid="input-sample-size"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="gdtType">GD&T Type (Optional)</Label>
                        <Input
                          id="gdtType"
                          placeholder="e.g., Position, Flatness"
                          value={formData.gdtType}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              gdtType: e.target.value,
                            })
                          }
                          data-testid="input-gdt-type"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="gdtTolerance">GD&T Tolerance</Label>
                        <Input
                          id="gdtTolerance"
                          placeholder="e.g., 0.01"
                          value={formData.gdtTolerance}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              gdtTolerance: e.target.value,
                            })
                          }
                          data-testid="input-gdt-tolerance"
                        />
                      </div>
                    </div>

                    <Separator className="my-2" />
                    <h4 className="text-sm font-semibold">
                      AS9102 Rev C Fields
                    </h4>

                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="characteristicDesignator">
                          Designator (Box 7)
                        </Label>
                        <Select
                          value={formData.characteristicDesignator}
                          onValueChange={(value) =>
                            setFormData({
                              ...formData,
                              characteristicDesignator: value,
                            })
                          }
                        >
                          <SelectTrigger
                            id="characteristicDesignator"
                            data-testid="select-designator"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="Critical">Critical</SelectItem>
                            <SelectItem value="Key">Key</SelectItem>
                            <SelectItem value="Major">Major</SelectItem>
                            <SelectItem value="Minor">Minor</SelectItem>
                            <SelectItem value="N/A">N/A</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="quantity">Quantity</Label>
                        <Input
                          id="quantity"
                          placeholder="e.g., 1, 4X, 2X"
                          value={formData.quantity}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              quantity: e.target.value,
                            })
                          }
                          data-testid="input-quantity"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="requirementType">Type</Label>
                        <Select
                          value={formData.requirementType}
                          onValueChange={(value) =>
                            setFormData({ ...formData, requirementType: value })
                          }
                        >
                          <SelectTrigger
                            id="requirementType"
                            data-testid="select-requirement-type"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="dimension">Dimension</SelectItem>
                            <SelectItem value="note">Note</SelectItem>
                            <SelectItem value="material">Material</SelectItem>
                            <SelectItem value="process">Process</SelectItem>
                            <SelectItem value="functional_test">
                              Functional Test
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="surfaceFinish">
                          Surface Finish (Optional)
                        </Label>
                        <Input
                          id="surfaceFinish"
                          placeholder="e.g., Ra 63, 125 RMS"
                          value={formData.surfaceFinish}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              surfaceFinish: e.target.value,
                            })
                          }
                          data-testid="input-surface-finish"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="passFailExpected">
                          Pass/Fail Expected (Optional)
                        </Label>
                        <Input
                          id="passFailExpected"
                          placeholder="e.g., PASS, FAIL, Compliant"
                          value={formData.passFailExpected}
                          onChange={(e) =>
                            setFormData({
                              ...formData,
                              passFailExpected: e.target.value,
                            })
                          }
                          data-testid="input-pass-fail-expected"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setDialogOpen(false)}
                      data-testid="button-cancel"
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={() => {
                        // Validate numeric fields
                        const tolerancePlus = parseFloat(
                          formData.tolerancePlus,
                        );
                        const toleranceMinus = parseFloat(
                          formData.toleranceMinus,
                        );
                        const sampleSize = parseInt(formData.sampleSize);
                        const gdtTolerance = formData.gdtTolerance
                          ? parseFloat(formData.gdtTolerance)
                          : null;

                        if (isNaN(tolerancePlus) || isNaN(toleranceMinus)) {
                          toast({
                            title: "Invalid tolerance",
                            description:
                              "Please enter valid numeric values for tolerances",
                            variant: "destructive",
                          });
                          return;
                        }

                        if (isNaN(sampleSize) || sampleSize < 1) {
                          toast({
                            title: "Invalid sample size",
                            description: "Sample size must be at least 1",
                            variant: "destructive",
                          });
                          return;
                        }

                        if (
                          formData.gdtTolerance &&
                          (gdtTolerance === null || isNaN(gdtTolerance))
                        ) {
                          toast({
                            title: "Invalid GD&T tolerance",
                            description:
                              "Please enter a valid numeric value for GD&T tolerance",
                            variant: "destructive",
                          });
                          return;
                        }

                        // Ensure all numeric fields are properly typed
                        createCharacteristicMutation.mutate({
                          description: formData.description,
                          specification: formData.specification,
                          tolerancePlus: Number(tolerancePlus),
                          toleranceMinus: Number(toleranceMinus),
                          unit: formData.unit,
                          inspectionMethod: formData.inspectionMethod,
                          sampleSize: Number(sampleSize),
                          gdtType: formData.gdtType || null,
                          gdtTolerance:
                            gdtTolerance !== null ? Number(gdtTolerance) : null,
                          // AS9102 Rev C fields
                          characteristicDesignator:
                            formData.characteristicDesignator,
                          quantity: formData.quantity,
                          surfaceFinish: formData.surfaceFinish || null,
                          requirementType: formData.requirementType,
                          passFailExpected: formData.passFailExpected || null,
                        });
                      }}
                      disabled={
                        createCharacteristicMutation.isPending ||
                        !formData.description ||
                        !formData.specification
                      }
                      data-testid="button-create-characteristic"
                    >
                      {createCharacteristicMutation.isPending
                        ? "Creating..."
                        : "Create Characteristic"}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>

        <div
          ref={containerRef}
          className="flex-1 overflow-auto bg-gray-900 flex items-center justify-center relative"
        >
          {selectedPdf ? (
            <div className="relative">
              <Document
                file={selectedPdf.pdfUrl}
                onLoadSuccess={({ numPages }) => setNumPages(numPages)}
              >
                <Page
                  pageNumber={activePage}
                  scale={scale}
                  onRenderSuccess={(page) => {
                    // Cache page proxy for viewport transforms (annotations)
                    pageProxyRef.current = page;

                    // Capture actual PDF page dimensions for accurate balloon positioning
                    setPageSize({
                      width: page.width / scale,
                      height: page.height / scale,
                    });
                  }}
                />
              </Document>
              <canvas
                ref={canvasRef}
                className="absolute top-0 left-0 pointer-events-auto cursor-crosshair"
                width={pageSize.width * scale}
                height={pageSize.height * scale}
                onClick={handleCanvasClick}
                style={{ cursor: tool === "balloon" ? "crosshair" : "default" }}
              />
            </div>
          ) : (
            <div className="text-center text-gray-400 space-y-3">
              <Upload className="h-16 w-16 mx-auto opacity-50" />
              <p className="text-sm">Select a drawing to view</p>
            </div>
          )}
        </div>
      </div>

      <div className="w-80 border-l bg-card p-4 space-y-4 overflow-auto">
        <div>
          <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-3">
            Drawings
          </h3>
          <div className="space-y-2">
            {drawingsLoading ? (
              <p className="text-sm text-muted-foreground">
                Loading drawings...
              </p>
            ) : drawings && drawings.length > 0 ? (
              drawings.map((drawing) => (
                <Card
                  key={drawing.id}
                  className={`cursor-pointer hover-elevate ${selectedDrawing === drawing.id ? "ring-2 ring-primary" : ""}`}
                  onClick={() => setSelectedDrawing(drawing.id)}
                  data-testid={`card-drawing-${drawing.id}`}
                >
                  <CardContent className="p-3">
                    <p className="text-sm font-medium truncate">
                      {drawing.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(drawing.uploadedAt).toLocaleDateString()}
                    </p>
                  </CardContent>
                </Card>
              ))
            ) : (
              <div className="text-center py-4">
                <p className="text-sm text-muted-foreground">
                  No drawings uploaded
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Upload a PDF from the Projects tab
                </p>
              </div>
            )}
          </div>
        </div>

        <Separator />

        <div>
          <h3 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-3">
            Balloons ({savedBalloons?.length || 0})
          </h3>
          <div className="space-y-2">
            {selectedDrawing &&
              savedBalloons?.length === 0 &&
              characteristics?.length === 0 && (
                <Card className="bg-muted/30 border-muted">
                  <CardContent className="p-3 space-y-2">
                    <p className="text-sm font-medium">
                      No Part Dimensions Found
                    </p>
                    <p className="text-xs text-muted-foreground">
                      AI extraction completed but found no measurable part
                      dimensions on this drawing. This could mean the drawing
                      contains only template elements, or has no dimensions at
                      all.
                    </p>
                    <div className="text-xs text-muted-foreground pt-2 border-t border-border/50">
                      <strong>Next Steps:</strong>
                      <ul className="list-disc list-inside mt-1 space-y-0.5">
                        <li>
                          Upload a drawing with dimension callouts and tolerance
                          specifications
                        </li>
                        <li>
                          Check GET /api/filtered-dimensions to see what was
                          classified
                        </li>
                        <li>Manually add characteristics if needed</li>
                      </ul>
                    </div>
                  </CardContent>
                </Card>
              )}
            {savedBalloons
              ?.sort((a, b) => a.balloonNumber - b.balloonNumber)
              .map((balloon, index) => {
                const char = balloon.characteristic;
                const dimensionText = char
                  ? `${char.specification}${char.tolerancePlus !== null && char.toleranceMinus !== null ? ` ±${Math.abs(char.tolerancePlus)}` : ""}`
                  : `(${Math.round(balloon.xPosition)}, ${Math.round(balloon.yPosition)})`;

                const canMoveUp = index > 0;
                const canMoveDown = index < savedBalloons.length - 1;

                return (
                  <div
                    key={balloon.id}
                    className="p-2 rounded-md bg-muted space-y-2"
                    data-testid={`balloon-${balloon.balloonNumber}`}
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">
                        {balloon.balloonNumber}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-mono truncate">
                          {dimensionText}
                        </div>
                        {char && (
                          <div className="text-xs text-muted-foreground truncate">
                            {char.description}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          disabled={!canMoveUp || reorderMutation.isPending}
                          onClick={() => {
                            const prevBalloon = savedBalloons[index - 1];
                            if (prevBalloon) {
                              reorderMutation.mutate({
                                balloon1Id: balloon.id,
                                balloon2Id: prevBalloon.id,
                              });
                            }
                          }}
                          data-testid={`button-balloon-up-${balloon.balloonNumber}`}
                        >
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          disabled={!canMoveDown || reorderMutation.isPending}
                          onClick={() => {
                            const nextBalloon = savedBalloons[index + 1];
                            if (nextBalloon) {
                              reorderMutation.mutate({
                                balloon1Id: balloon.id,
                                balloon2Id: nextBalloon.id,
                              });
                            }
                          }}
                          data-testid={`button-balloon-down-${balloon.balloonNumber}`}
                        >
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    {char && (
                      <div className="text-xs space-y-1 pl-10">
                        <div className="flex gap-2">
                          <span className="text-muted-foreground">Zone:</span>
                          <span className="font-mono">
                            {char.drawingZone || "N/A"}
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <span className="text-muted-foreground">
                            Designator:
                          </span>
                          <span className="font-semibold">
                            {char.characteristicDesignator || "N/A"}
                          </span>
                        </div>
                        {char.quantity && char.quantity !== "1" && (
                          <div className="flex gap-2">
                            <span className="text-muted-foreground">Qty:</span>
                            <span>{char.quantity}</span>
                          </div>
                        )}
                        {char.surfaceFinish && (
                          <div className="flex gap-2">
                            <span className="text-muted-foreground">
                              Finish:
                            </span>
                            <span>{char.surfaceFinish}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
