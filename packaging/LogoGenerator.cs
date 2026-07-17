using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

class LogoGenerator
{
    static void Main(string[] args)
    {
        string outputPath = args.Length > 0 ? args[0] : "logo.ico";
        
        using (Bitmap bmp16 = CreateLogoBitmap(16))
        using (Bitmap bmp32 = CreateLogoBitmap(32))
        using (Bitmap bmp64 = CreateLogoBitmap(64))
        {
            SaveAsIcon(new Bitmap[] { bmp16, bmp32, bmp64 }, outputPath);
            Console.WriteLine("Logo generated: " + outputPath);
        }
    }

    static Bitmap CreateLogoBitmap(int size)
    {
        Bitmap bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            
            int padding = size / 8;
            int paperSize = size - padding * 2;
            
            Color paperLight = Color.FromArgb(224, 231, 255);
            Color paperMid = Color.FromArgb(199, 210, 254);
            Color paperDark = Color.FromArgb(165, 180, 252);
            Color darkPaper = Color.FromArgb(99, 102, 241);
            Color darkPaperBorder = Color.FromArgb(67, 56, 202);
            
            LinearGradientBrush darkPaperBrush = new LinearGradientBrush(
                new Rectangle(padding, padding + 4, paperSize, paperSize),
                Color.FromArgb(99, 102, 241),
                Color.FromArgb(79, 70, 229),
                LinearGradientMode.ForwardDiagonal
            );
            
            int r = paperSize / 6;
            GraphicsPath darkPath = new GraphicsPath();
            darkPath.AddArc(padding, padding + 4, r, r, 180, 90);
            darkPath.AddArc(padding + paperSize - r, padding + 4, r, r, 270, 90);
            darkPath.AddArc(padding + paperSize - r, padding + paperSize + 4 - r, r, r, 0, 90);
            darkPath.AddArc(padding, padding + paperSize + 4 - r, r, r, 90, 90);
            darkPath.CloseFigure();
            g.FillPath(darkPaperBrush, darkPath);
            
            LinearGradientBrush paperBrush = new LinearGradientBrush(
                new Rectangle(padding, padding, paperSize, paperSize),
                paperLight,
                paperDark,
                LinearGradientMode.ForwardDiagonal
            );
            
            int foldY = padding + paperSize * 3 / 4;
            int foldX = padding + paperSize * 3 / 4;
            
            Point[] paperPoints = {
                new Point(padding, padding),
                new Point(padding + paperSize, padding),
                new Point(padding + paperSize, foldY),
                new Point(foldX, padding + paperSize + 4),
                new Point(padding, padding + paperSize)
            };
            
            GraphicsPath paperPath = new GraphicsPath();
            paperPath.AddPolygon(paperPoints);
            g.FillPath(paperBrush, paperPath);
            g.DrawPath(new Pen(darkPaperBorder, 1), paperPath);
            
            float lineHeight = paperSize / 7f;
            float lineStart = padding + paperSize / 5f;
            float lineWidth = paperSize * 2 / 3f;
            
            SolidBrush lineBrush = new SolidBrush(Color.FromArgb(147, 197, 253));
            
            g.FillRectangle(lineBrush, lineStart, padding + lineHeight * 1.2f, lineWidth * 0.9f, 1.5f);
            g.FillRectangle(lineBrush, lineStart, padding + lineHeight * 2.5f, lineWidth * 0.8f, 1.5f);
            g.FillRectangle(lineBrush, lineStart, padding + lineHeight * 3.8f, lineWidth, 1.5f);
            g.FillRectangle(lineBrush, lineStart + paperSize / 10f, padding + lineHeight * 5f, lineWidth * 0.7f, 1.5f);
            
            Color nodeColor = Color.FromArgb(34, 211, 238);
            Color nodeBorder = Color.FromArgb(6, 182, 212);
            
            int nodeAreaX = padding + paperSize + padding / 2;
            int nodeAreaY = padding;
            
            if (size >= 16)
            {
                float nodeScale = size / 64f;
                
                int node1X = (int)(nodeAreaX + 8 * nodeScale);
                int node1Y = (int)(nodeAreaY + 12 * nodeScale);
                int node1R = (int)(6 * nodeScale);
                
                int node2X = (int)(nodeAreaX + 16 * nodeScale);
                int node2Y = (int)(nodeAreaY + 24 * nodeScale);
                int node2R = (int)(5 * nodeScale);
                
                int node3X = (int)(nodeAreaX + 4 * nodeScale);
                int node3Y = (int)(nodeAreaY + 32 * nodeScale);
                int node3R = (int)(5 * nodeScale);
                
                int node4X = (int)(nodeAreaX + 12 * nodeScale);
                int node4Y = (int)(nodeAreaY + 40 * nodeScale);
                int node4R = (int)(4 * nodeScale);
                
                LinearGradientBrush nodeBrush = new LinearGradientBrush(
                    new Rectangle(0, 0, 10, 10),
                    nodeColor,
                    Color.FromArgb(6, 182, 212),
                    LinearGradientMode.ForwardDiagonal
                );
                
                g.FillEllipse(nodeBrush, node1X - node1R, node1Y - node1R, node1R * 2, node1R * 2);
                g.FillEllipse(nodeBrush, node2X - node2R, node2Y - node2R, node2R * 2, node2R * 2);
                g.FillEllipse(nodeBrush, node3X - node3R, node3Y - node3R, node3R * 2, node3R * 2);
                g.FillEllipse(nodeBrush, node4X - node4R, node4Y - node4R, node4R * 2, node4R * 2);
                
                Pen linePen = new Pen(nodeBorder, 1.5f);
                g.DrawLine(linePen, node1X, node1Y, node2X, node2Y);
                g.DrawLine(linePen, node2X, node2Y, node3X, node3Y);
                g.DrawLine(linePen, node3X, node3Y, node4X, node4Y);
                g.DrawLine(linePen, node1X, node1Y, node3X, node3Y);
            }
        }
        return bmp;
    }

    static void SaveAsIcon(Bitmap[] bitmaps, string filePath)
    {
        using (FileStream fs = new FileStream(filePath, FileMode.Create))
        {
            BinaryWriter bw = new BinaryWriter(fs);
            
            bw.Write((short)0);
            bw.Write((short)1);
            bw.Write((short)bitmaps.Length);
            
            int offset = 6 + bitmaps.Length * 16;
            
            foreach (Bitmap bmp in bitmaps)
            {
                bw.Write((byte)bmp.Width);
                bw.Write((byte)bmp.Height);
                bw.Write((byte)0);
                bw.Write((byte)0);
                bw.Write((short)1);
                bw.Write((short)32);
                bw.Write(bmp.Width * bmp.Height * 4);
                bw.Write(offset);
                offset += bmp.Width * bmp.Height * 4;
            }
            
            foreach (Bitmap bmp in bitmaps)
            {
                for (int y = bmp.Height - 1; y >= 0; y--)
                {
                    for (int x = 0; x < bmp.Width; x++)
                    {
                        Color c = bmp.GetPixel(x, y);
                        bw.Write(c.B);
                        bw.Write(c.G);
                        bw.Write(c.R);
                        bw.Write(c.A);
                    }
                }
            }
            
            bw.Flush();
        }
    }
}