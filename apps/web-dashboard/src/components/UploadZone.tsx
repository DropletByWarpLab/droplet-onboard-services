"use client";

import { useCallback, useRef, useState } from "react";
import { Upload } from "lucide-react";

interface UploadZoneProps {
  onUpload: (files: FileList) => void;
  children: React.ReactNode;
}

export function UploadZone({ onUpload, children }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        onUpload(e.dataTransfer.files);
      }
    },
    [onUpload]
  );

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  return (
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onUpload(e.target.files);
            e.target.value = "";
          }
        }}
      />

      {isDragging && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-accent/5 border-2 border-dashed border-accent rounded-lg transition-all duration-200">
          <div className="text-center">
            <Upload size={32} className="mx-auto text-accent mb-2" />
            <p className="type-subheadline text-accent">Drop files to upload</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function UploadButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="dp-btn-primary type-subheadline !py-2 !px-4 !min-h-[36px]"
    >
      <Upload size={14} />
      Upload
    </button>
  );
}
