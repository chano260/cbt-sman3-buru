package id.sch.sman3buru.exambro;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Tempat aplikasi kamera menyimpan foto lembar jawaban esai (resolusi penuh).
 * Pengganti androidx FileProvider, karena APK dibangun dengan javac biasa tanpa androidx.
 * Provider tidak di-export: aplikasi kamera hanya mendapat izin tulis sementara
 * lewat FLAG_GRANT_WRITE_URI_PERMISSION untuk satu file ini.
 */
public class PhotoProvider extends ContentProvider {

    public static final String AUTHORITY = "id.sch.sman3buru.exambro.photos";
    private static final String FILE_NAME = "lembar_jawaban_esai.jpg";

    public static File photoFile(Context context) {
        File dir = new File(context.getCacheDir(), "essay");
        if (!dir.exists()) dir.mkdirs();
        return new File(dir, FILE_NAME);
    }

    public static Uri photoUri() {
        return Uri.parse("content://" + AUTHORITY + "/" + FILE_NAME);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!FILE_NAME.equals(uri.getLastPathSegment())) {
            throw new FileNotFoundException("File tidak dikenal: " + uri);
        }
        File file = photoFile(getContext());
        int flags = ParcelFileDescriptor.parseMode(mode);
        return ParcelFileDescriptor.open(file, flags | (mode.contains("w") ? ParcelFileDescriptor.MODE_CREATE : 0));
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File file = photoFile(getContext());
        MatrixCursor cursor = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
        cursor.addRow(new Object[] { FILE_NAME, file.length() });
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
