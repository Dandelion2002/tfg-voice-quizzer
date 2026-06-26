// Autor:   María León Pérez
// Resumen: Componente de logotipo de Voice Quizzer. Muestra un cuadrado naranja con la
//          letra "V". Acepta className para redimensionarlo y onClick para usarlo como
//          botón de navegación en el header.
import React from 'react';

interface LogoProps {
  className?: string;
  onClick?: () => void;
  src?: string;
}

export default function Logo({ className = "w-8 h-8", onClick, src = "/logotipo.png" }: LogoProps) {
  return (
    <img
      src={src}
      alt="VoiceQuizzer"
      onClick={onClick}
      className={`object-contain cursor-pointer ${className}`}
    />
  );
}
