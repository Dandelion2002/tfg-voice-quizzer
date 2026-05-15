// Autor:   María León Pérez
// Resumen: Componente de logotipo de Voice Quizzer. Muestra un cuadrado naranja con la
//          letra "V". Acepta className para redimensionarlo y onClick para usarlo como
//          botón de navegación en el header.
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
