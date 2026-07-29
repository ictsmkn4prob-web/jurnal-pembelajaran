// Ganti dengan URL Web App GAS Anda yang baru
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwkVtjwNIrXLD5GOSLbOOLvTWD-20Lsvrgk6gYj68QDpe77TsmhRBIh7sRAj_0ePNYO4Q/exec';

// Fungsi untuk POST (Simpan Data)
async function simpanJurnal() {
    const namaGuru = document.getElementById('namaGuru').value;
    const materi = document.getElementById('materi').value;
    const statusPesan = document.getElementById('statusPesan');

    statusPesan.innerText = "Menyimpan data...";

    const payload = {
        action: 'simpanJurnal',
        namaGuru: namaGuru,
        materi: materi
    };

    try {
        const response = await fetch(GAS_URL, {
            method: 'POST',
            // Gunakan text/plain untuk menghindari error CORS (aturan keamanan browser) pada GAS
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        statusPesan.innerText = result.message;
    } catch (error) {
        statusPesan.innerText = "Gagal menyimpan data.";
        console.error(error);
    }
}

// Fungsi untuk GET (Ambil Data)
async function ambilDataSiswa() {
    const tampilData = document.getElementById('tampilData');
    tampilData.innerText = "Mengambil data...";

    try {
        // Menambahkan parameter ?action=getSiswa di akhir URL
        const response = await fetch(GAS_URL + '?action=getSiswa');
        const result = await response.json();
        
        tampilData.innerText = JSON.stringify(result.data, null, 2);
    } catch (error) {
        tampilData.innerText = "Gagal mengambil data.";
        console.error(error);
    }
}