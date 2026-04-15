import React from 'react';

interface LogoProps {
  className?: string;
  onClick?: () => void;
}

export default function Logo({ className = "w-8 h-8", onClick }: LogoProps) {
  return (
    <div 
      onClick={onClick}
      className={`bg-tepro-orange rounded-lg flex items-center justify-center cursor-pointer ${className}`}
    >
      {/* Placeholder for actual logo image */}
      <span className="text-white font-bold text-xl">V</span>
    </div>
  );
}
