import { Inter } from 'next/font/google';
import './globals.scss';
import { SocketProvider } from "@contexts/SocketContext";

// Types
import type { Metadata } from 'next';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'App Router Template',
  description: 'App Router Template',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <SocketProvider>
          {children}
        </SocketProvider>
      </body>
    </html>
  );
}
