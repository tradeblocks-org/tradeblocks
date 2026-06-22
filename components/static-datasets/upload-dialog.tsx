"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, FileText, AlertCircle, Loader2 } from "lucide-react";
import { CSVParser } from "@tradeblocks/lib";
import { suggestDatasetName } from "@tradeblocks/lib";
import { useStaticDatasetsStore } from "@tradeblocks/lib/stores";
import type { ParseProgress } from "@tradeblocks/lib";

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UploadDialog({ open, onOpenChange }: UploadDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStep, setUploadStep] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadDataset = useStaticDatasetsStore((state) => state.uploadDataset);
  const validateName = useStaticDatasetsStore((state) => state.validateName);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;

    // Validate file
    const validation = CSVParser.validateCSVFile(selectedFile);
    if (!validation.valid) {
      setUploadError(validation.error || "Invalid file");
      return;
    }

    setFile(selectedFile);
    setUploadError(null);

    // Suggest name from filename
    const suggestedName = suggestDatasetName(selectedFile.name);
    setName(suggestedName);
    setNameError(null);
  }, []);

  const handleNameChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const newName = e.target.value;
      setName(newName);

      if (newName.trim()) {
        const validation = await validateName(newName);
        setNameError(validation.valid ? null : validation.error || null);
      } else {
        setNameError("Name is required");
      }
    },
    [validateName],
  );

  const handleUpload = useCallback(async () => {
    if (!file || !name.trim() || nameError) return;

    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(0);
    setUploadStep("Reading file...");

    const handleProgress = (progress: ParseProgress) => {
      setUploadProgress(progress.progress);
      switch (progress.stage) {
        case "reading":
          setUploadStep("Reading file...");
          break;
        case "parsing":
          setUploadStep(`Parsing rows... (${progress.rowsProcessed} processed)`);
          break;
        case "validating":
          setUploadStep("Validating data...");
          break;
        case "converting":
          setUploadStep("Processing timestamps...");
          break;
        case "completed":
          setUploadStep("Saving to database...");
          break;
      }
    };

    const result = await uploadDataset(file, name.trim(), handleProgress);

    if (result.success) {
      // Reset and close
      setFile(null);
      setName("");
      setNameError(null);
      setUploadProgress(0);
      setUploadStep("");
      onOpenChange(false);
    } else {
      setUploadError(result.error || "Upload failed");
    }

    setIsUploading(false);
  }, [file, name, nameError, uploadDataset, onOpenChange]);

  const handleClose = useCallback(() => {
    if (isUploading) return;

    setFile(null);
    setName("");
    setNameError(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadStep("");
    onOpenChange(false);
  }, [isUploading, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Static Dataset</DialogTitle>
          <DialogDescription>
            Upload a CSV file with time-series data. The first column must be the timestamp. Dataset
            columns will be available as fields in the Report Builder, matched to trades by
            timestamp.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* File Upload */}
          <div className="space-y-2">
            <Label htmlFor="file">CSV File</Label>
            {!file ? (
              <div className="border-2 border-dashed rounded-lg p-6 text-center hover:border-primary/50 transition-colors">
                <Input
                  id="file"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFileChange}
                  className="hidden"
                  disabled={isUploading}
                />
                <label htmlFor="file" className="cursor-pointer flex flex-col items-center gap-2">
                  <Upload className="w-8 h-8 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Click to select a CSV file</span>
                </label>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
                <FileText className="w-8 h-8 text-primary" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(file.size / 1024).toFixed(1)} KB
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setFile(null);
                    setName("");
                  }}
                  disabled={isUploading}
                >
                  Change
                </Button>
              </div>
            )}
          </div>

          {/* Dataset Name */}
          {file && (
            <div className="space-y-2">
              <Label htmlFor="name">Dataset Name</Label>
              <Input
                id="name"
                value={name}
                onChange={handleNameChange}
                placeholder="e.g., VIX, SPX Daily"
                disabled={isUploading}
              />
              {nameError && <p className="text-xs text-destructive">{nameError}</p>}
              <p className="text-xs text-muted-foreground">
                This name will be used as a prefix for columns in Report Builder.
              </p>
            </div>
          )}

          {/* Upload Progress */}
          {isUploading && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{uploadStep}</span>
              </div>
              <Progress value={uploadProgress} />
            </div>
          )}

          {/* Error */}
          {uploadError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{uploadError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isUploading}>
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={!file || !name.trim() || !!nameError || isUploading}
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              "Upload"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
