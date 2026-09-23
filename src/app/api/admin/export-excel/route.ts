import { NextResponse } from 'next/server';
import { AdminAuthError, requireAdmin } from '@/lib/admin-auth';
import { supabase } from '@/lib/supabase';
import ExcelJS from 'exceljs';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, ['ADMIN', 'MANAGER']);
    const url = new URL(request.url);
    const dateFrom = url.searchParams.get('date_from');
    const dateTo = url.searchParams.get('date_to');

    let query = supabase
      .from('bookings')
      .select(
        'id,reference,visit_date,status,payment_method,total_amount,people_count,created_at,voucher_issued,' +
        'customers(first_name,last_name,email,phone),' +
        'booking_items(quantity,subtotal,metadata,packages(name),huts(name)),' +
        'tickets(id,ticket_uid,status)'
      )
      .order('visit_date', { ascending: false });

    if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      query = query.gte('visit_date', dateFrom);
    }
    if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      query = query.lte('visit_date', dateTo);
    }

    const { data, error } = await query.limit(10000);
    if (error) throw error;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase returns a union with GenericStringError; after error check, data is always the expected shape
    const bookings = (data || []) as any[];

    // ── Build the workbook ──────────────────────────────────────────────
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Graceland Venues';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Bookings', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    // Column definitions
    sheet.columns = [
      { header: 'Customer Name', key: 'customer_name', width: 28 },
      { header: 'Email', key: 'email', width: 32 },
      { header: 'Phone', key: 'phone', width: 18 },
      { header: 'Visit Date', key: 'visit_date', width: 14 },
      { header: 'Total (R)', key: 'total', width: 14 },
      { header: 'People', key: 'people', width: 10 },
      { header: 'Payment', key: 'payment', width: 18 },
      { header: 'Voucher Issued', key: 'voucher_issued', width: 16 },
      { header: 'Items', key: 'items', width: 48 },
      { header: 'Ticket IDs', key: 'ticket_ids', width: 52 },
    ];

    // Style the header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0EA5E9' }, // matches --primary
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    headerRow.height = 28;

    // Add data rows
    for (const booking of bookings) {
      const customer = Array.isArray(booking.customers)
        ? booking.customers[0]
        : booking.customers;

      const items = (booking.booking_items || [])
        .map(
          (item: { packages?: { name: string }[]; huts?: { name: string }[]; metadata?: { name?: string } | null; quantity: number; subtotal: number }) =>
            `${item.packages?.[0]?.name || item.huts?.[0]?.name || item.metadata?.name || 'Item'} × ${item.quantity} (R ${Number(item.subtotal).toFixed(2)})`
        )
        .join('\n');

      const ticketIds = (booking.tickets || [])
        .map((t: { ticket_uid: string; status: string }) => `${t.ticket_uid} [${t.status}]`)
        .join('\n');

      sheet.addRow({
        customer_name: `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim() || '—',
        email: customer?.email || '—',
        phone: customer?.phone || '—',
        visit_date: booking.visit_date,
        total: Number(booking.total_amount),
        people: booking.people_count,
        payment: booking.payment_method || 'Pending',
        voucher_issued: booking.voucher_issued ? 'Yes' : 'No',
        items: items || '—',
        ticket_ids: ticketIds || 'None issued',
      });
    }

    // Style data rows
    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex++) {
      const row = sheet.getRow(rowIndex);
      row.alignment = { vertical: 'top', wrapText: true };

      // Alternate row background
      if (rowIndex % 2 === 0) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF0F9FF' }, // very light blue
        };
      }

      // Format currency column
      const totalCell = row.getCell('total');
      totalCell.numFmt = '#,##0.00';
      totalCell.alignment = { vertical: 'top', horizontal: 'right' };

      // Center-align people and voucher columns
      row.getCell('people').alignment = { vertical: 'top', horizontal: 'center' };
      row.getCell('voucher_issued').alignment = { vertical: 'top', horizontal: 'center' };
      row.getCell('visit_date').alignment = { vertical: 'top', horizontal: 'center' };
    }

    // Add borders to all cells
    const borderStyle: Partial<ExcelJS.Borders> = {
      top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    };
    sheet.eachRow(row => {
      row.eachCell(cell => {
        cell.border = borderStyle;
      });
    });

    // Auto-filter on all columns
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: 10 },
    };

    // Generate the file name
    let filename = 'graceland-bookings';
    if (dateFrom && dateTo) {
      filename += `-${dateFrom}-to-${dateTo}`;
    } else if (dateFrom) {
      filename += `-from-${dateFrom}`;
    } else if (dateTo) {
      filename += `-to-${dateTo}`;
    } else {
      filename += '-all';
    }
    filename += '.xlsx';

    // Write buffer
    const buffer = await workbook.xlsx.writeBuffer();

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof AdminAuthError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('Admin Excel export error', error);
    return NextResponse.json({ success: false, error: 'Could not export bookings' }, { status: 500 });
  }
}
