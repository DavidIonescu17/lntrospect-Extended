import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView, Share, FlatList, ActivityIndicator, Alert, Modal, TextInput, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { auth, db } from '../firebaseConfig';
import { signOut } from 'firebase/auth';
import { doc, getDoc, updateDoc, collection, query, where, onSnapshot, orderBy, addDoc, Timestamp, getDocs } from 'firebase/firestore';
import { FontAwesome } from '@expo/vector-icons';

export default function PsychologistDashboard() {
    const router = useRouter();
    const [user, setUser] = useState<any>(null);
    const [pairingCode, setPairingCode] = useState<string | null>(null);
    const [clients, setClients] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    // Profile Editing State
    const [editModalVisible, setEditModalVisible] = useState(false);
    const [newName, setNewName] = useState('');
    const [newTitle, setNewTitle] = useState('');

    // Client Viewing State
    const [selectedClient, setSelectedClient] = useState<any>(null);
    const [clientJournals, setClientJournals] = useState<any[]>([]);
    const [loadingJournals, setLoadingJournals] = useState(false);
    
    // Appointments State
    const [appointmentsModalVisible, setAppointmentsModalVisible] = useState(false);
    const [appointments, setAppointments] = useState<any[]>([]);
    const [loadingAppointments, setLoadingAppointments] = useState(false);
    const [scheduleModalVisible, setScheduleModalVisible] = useState(false);
    const [scheduleClientId, setScheduleClientId] = useState<string | null>(null);
    const [scheduleDate, setScheduleDate] = useState('');
    const [scheduleTime, setScheduleTime] = useState('');
    const [scheduleNotes, setScheduleNotes] = useState('');
    
    // Clinical Notes State
    const [notesModalVisible, setNotesModalVisible] = useState(false);
    const [selectedAppointment, setSelectedAppointment] = useState<any>(null);
    const [clinicalNote, setClinicalNote] = useState('');
    const [savingNote, setSavingNote] = useState(false);

    const generateSecureFourDigitCode = () => {
        const array = new Uint16Array(1);
        window.crypto.getRandomValues(array);
        // Ensure it's 4 digits (1000-9999)
        return (array[0] % 9000) + 1000;
    };

    // 1. Initial Data Load
    useEffect(() => {
        const currentUser = auth.currentUser;
        if (!currentUser) return;

        const fetchProfile = async () => {
            const userRef = doc(db, 'users', currentUser.uid);
            const userSnap = await getDoc(userRef);
            if (userSnap.exists()) {
                const data = userSnap.data();
                setUser(data);
                setNewName(data.fullName || '');
                setNewTitle(data.title || ''); 

                if (!data.pairingCode) {
                    const namePart = (data.fullName || "DOC").substring(0, 3).toUpperCase();
                    const randomPart = generateSecureFourDigitCode();
                    const newCode = `${namePart}-${randomPart}`;
                    await updateDoc(userRef, { pairingCode: newCode });
                    setPairingCode(newCode);
                } else {
                    setPairingCode(data.pairingCode);
                }
            }
            setLoading(false);
        };
        fetchProfile();

        const q = query(collection(db, 'users'), where('psychologistId', '==', currentUser.uid));
        
        const unsubscribe = onSnapshot(q, async (snapshot) => {
            const basicClients = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            
            const fullClients = await Promise.all(basicClients.map(async (client) => {
                try {
                    const profileDoc = await getDoc(doc(db, 'user_profiles', client.id));
                    if (profileDoc.exists()) {
                        const profileData = profileDoc.data();
                        return { ...client, profileName: profileData.name };
                    }
                } catch (e) {
                    console.log("Could not fetch profile for", client.id);
                }
                return client;
            }));

            setClients(fullClients);
        });

        // Set up appointment reminders
        checkAppointmentReminders();
        const reminderInterval = setInterval(checkAppointmentReminders, 60000);

        return () => {
            unsubscribe();
            clearInterval(reminderInterval);
        };
    }, []);

    const checkAppointmentReminders = async () => {
        if (!auth.currentUser) return;
        
        try {
            const now = new Date();
            const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const in1Hour = new Date(now.getTime() + 60 * 60 * 1000);
            
            const q = query(
                collection(db, 'appointments'),
                where('psychologistId', '==', auth.currentUser.uid),
                where('status', '==', 'confirmed')
            );
            
            const snapshot = await getDocs(q);
            snapshot.docs.forEach(async (docSnap) => {
                const data = docSnap.data();
                const appointmentTime = data.scheduledTime.toDate();
                
                // Get client name
                const clientDoc = await getDoc(doc(db, 'users', data.clientId));
                const clientName = clientDoc.exists() ? clientDoc.data().fullName : 'a client';
                
                if (Math.abs(appointmentTime.getTime() - in24Hours.getTime()) < 5 * 60 * 1000) {
                    Alert.alert(
                        'Appointment Reminder',
                        `You have an appointment in 24 hours with ${clientName}`,
                        [{ text: 'OK' }]
                    );
                }
                
                if (Math.abs(appointmentTime.getTime() - in1Hour.getTime()) < 5 * 60 * 1000) {
                    Alert.alert(
                        'Appointment Starting Soon',
                        `Your appointment with ${clientName} starts in 1 hour`,
                        [{ text: 'OK' }]
                    );
                }
            });
        } catch (error) {
            console.error('Error checking reminders:', error);
        }
    };

    const handleUpdateProfile = async () => {
        if (!auth.currentUser) return;
        try {
            await updateDoc(doc(db, 'users', auth.currentUser.uid), {
                fullName: newName,
                title: newTitle
            });
            setUser({ ...user, fullName: newName, title: newTitle });
            setEditModalVisible(false);
            Alert.alert("Success", "Profile updated! Clients will see these details.");
        } catch (error) {
            Alert.alert("Error", "Could not update profile.");
        }
    };

    const handleViewClient = async (client: any) => {
        setSelectedClient(client);
        setLoadingJournals(true);
        try {
            const q = query(
                collection(db, 'journal_entries'),
                where('userId', '==', client.id),
                where('isShared', '==', true), 
                orderBy('createdAt', 'desc')
            );
            
            const unsubscribe = onSnapshot(q, (snapshot) => {
                const entries = snapshot.docs.map(d => {
                    const data = d.data();
                    return {
                        id: d.id,
                        ...data,
                        text: data.sharedText || "Message is encrypted",
                        mood: data.sharedMood || data.mood,
                        date: data.sharedDate || data.date
                    };
                });
                
                setClientJournals(entries);
                setLoadingJournals(false);
            });
            
        } catch (error) {
            console.log(error);
            setLoadingJournals(false);
        }
    };

    const handleOpenAppointments = async () => {
        setAppointmentsModalVisible(true);
        setLoadingAppointments(true);
        try {
            const q = query(
                collection(db, 'appointments'),
                where('psychologistId', '==', auth.currentUser!.uid),
                orderBy('scheduledTime', 'desc')
            );
            
            const snapshot = await getDocs(q);
            const appts = await Promise.all(snapshot.docs.map(async (docSnap) => {
                const data = docSnap.data();
                const clientDoc = await getDoc(doc(db, 'users', data.clientId));
                const clientName = clientDoc.exists() ? clientDoc.data().fullName : 'Unknown';
                
                return {
                    id: docSnap.id,
                    ...data,
                    clientName,
                    scheduledTime: data.scheduledTime.toDate()
                };
            }));
            
            setAppointments(appts);
        } catch (error) {
            Alert.alert("Error", "Could not load appointments");
        } finally {
            setLoadingAppointments(false);
        }
    };

    const handleScheduleAppointment = async () => {
        if (!scheduleDate || !scheduleTime || !scheduleClientId) {
            Alert.alert("Error", "Please fill in all fields");
            return;
        }

        try {
            const scheduledTime = new Date(`${scheduleDate}T${scheduleTime}`);
            
            await addDoc(collection(db, 'appointments'), {
                clientId: scheduleClientId,
                psychologistId: auth.currentUser!.uid,
                scheduledTime: Timestamp.fromDate(scheduledTime),
                status: 'confirmed',
                psychologistNotes: scheduleNotes,
                createdAt: Timestamp.now()
            });

            Alert.alert("Success", "Appointment scheduled and client notified!");
            setScheduleModalVisible(false);
            setScheduleDate('');
            setScheduleTime('');
            setScheduleNotes('');
            setScheduleClientId(null);
            handleOpenAppointments();
        } catch (error) {
            Alert.alert("Error", "Failed to schedule appointment");
        }
    };

    const handleConfirmAppointment = async (appointmentId: string) => {
        try {
            await updateDoc(doc(db, 'appointments', appointmentId), {
                status: 'confirmed'
            });
            Alert.alert("Success", "Appointment confirmed!");
            handleOpenAppointments();
        } catch (error) {
            Alert.alert("Error", "Failed to confirm appointment");
        }
    };

    const handleCancelAppointment = async (appointmentId: string) => {
        Alert.alert(
            "Cancel Appointment",
            "Are you sure you want to cancel this appointment?",
            [
                { text: "No" },
                {
                    text: "Yes",
                    onPress: async () => {
                        try {
                            await updateDoc(doc(db, 'appointments', appointmentId), {
                                status: 'cancelled'
                            });
                            Alert.alert("Cancelled", "Appointment has been cancelled");
                            handleOpenAppointments();
                        } catch (error) {
                            Alert.alert("Error", "Failed to cancel appointment");
                        }
                    }
                }
            ]
        );
    };

    const handleOpenClinicalNotes = (appointment: any) => {
        setSelectedAppointment(appointment);
        setClinicalNote(appointment.clinicalNotes || '');
        setNotesModalVisible(true);
    };

    const handleSaveClinicalNotes = async () => {
        if (!selectedAppointment) return;
        
        setSavingNote(true);
        try {
            await updateDoc(doc(db, 'appointments', selectedAppointment.id), {
                clinicalNotes: clinicalNote,
                lastNotesUpdate: Timestamp.now()
            });
            
            Alert.alert("Success", "Clinical notes saved securely");
            setNotesModalVisible(false);
        } catch (error) {
            Alert.alert("Error", "Failed to save notes");
        } finally {
            setSavingNote(false);
        }
    };

    const handleShare = async () => {
        if (pairingCode) Share.share({ message: `Connect with me on the app! Code: ${pairingCode}` });
    };

    const handleSignOut = async () => {
        await signOut(auth);
        router.replace('/');
    };

    const getClientDisplayName = (client: any) => {
        return client.profileName || client.fullName || client.email?.split('@')[0] || "Client";
    };

    const getStatusColor = (status: string) => {
        switch(status) {
            case 'confirmed': return '#48BB78';
            case 'pending': return '#ECC94B';
            case 'cancelled': return '#F56565';
            default: return '#A0AEC0';
        }
    };

    const getStatusIcon = (status: string) => {
        switch(status) {
            case 'confirmed': return 'check-circle';
            case 'pending': return 'clock-o';
            case 'cancelled': return 'times-circle';
            default: return 'question-circle';
        }
    };

    const groupAppointmentsByDate = (appointments: any[]) => {
    const groups: { [key: string]: any[] } = {};

    appointments.forEach(appt => {
        const dateKey = appt.scheduledTime.toDateString();
        if (!groups[dateKey]) {
            groups[dateKey] = [];
        }
        groups[dateKey].push(appt);
    });

    return Object.entries(groups)
        .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    };


    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <View>
                    <Text style={styles.headerTitle}>{user?.fullName || "Doctor"}</Text>
                    <Text style={styles.headerSubtitle}>{user?.title || "Psychologist"}</Text>
                </View>
                <View style={{flexDirection:'row', gap: 15}}>
                    <TouchableOpacity onPress={handleOpenAppointments}>
                        <FontAwesome name="calendar" size={24} color="white" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setEditModalVisible(true)}>
                        <FontAwesome name="pencil" size={24} color="white" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={handleSignOut}>
                        <FontAwesome name="sign-out" size={24} color="white" />
                    </TouchableOpacity>
                </View>
            </View>

            <View style={styles.content}>
                <View style={styles.card}>
                    <Text style={styles.cardTitle}>Pairing Code</Text>
                    <TouchableOpacity onPress={handleShare} style={styles.codeBox}>
                        {loading ? <ActivityIndicator color="#6B4EFF" /> : (
                            <Text style={styles.codeText}>{pairingCode}</Text>
                        )}
                        <FontAwesome name="share-alt" size={20} color="#6B4EFF" />
                    </TouchableOpacity>
                </View>

                <Text style={styles.sectionTitle}>My Patients</Text>
                <FlatList 
                    data={clients}
                    keyExtractor={item => item.id}
                    ListEmptyComponent={<Text style={styles.emptyText}>No patients connected yet.</Text>}
                    renderItem={({ item }) => (
                        <View style={styles.clientItemContainer}>
                            <TouchableOpacity 
                                style={styles.clientItem} 
                                onPress={() => handleViewClient(item)}
                            >
                                <View style={styles.avatar}>
                                    <Text style={styles.avatarText}>
                                        {(getClientDisplayName(item)[0] || "U").toUpperCase()}
                                    </Text>
                                </View>
                                <View style={{flex:1}}>
                                    <Text style={styles.clientName}>{getClientDisplayName(item)}</Text>
                                    <Text style={styles.clientEmail}>{item.email}</Text>
                                </View>
                                <FontAwesome name="chevron-right" size={14} color="#CBD5E0" />
                            </TouchableOpacity>
                            <TouchableOpacity 
                                style={styles.scheduleButton}
                                onPress={() => {
                                    setScheduleClientId(item.id);
                                    setScheduleModalVisible(true);
                                }}
                            >
                                <FontAwesome name="calendar-plus-o" size={16} color="white" />
                                <Text style={styles.scheduleButtonText}>Schedule</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                />
            </View>

            {/* Edit Profile Modal */}
            <Modal visible={editModalVisible} animationType="slide" transparent={true}>
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Edit Public Profile</Text>
                        <TextInput 
                            style={styles.input} 
                            placeholder="Full Name (e.g. Dr. John)" 
                            value={newName} 
                            onChangeText={setNewName} 
                        />
                        <TextInput 
                            style={styles.input} 
                            placeholder="Title (e.g. Clinical Psychologist)" 
                            value={newTitle} 
                            onChangeText={setNewTitle} 
                        />
                        <TouchableOpacity style={styles.saveButton} onPress={handleUpdateProfile}>
                            <Text style={styles.saveText}>Save Details</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.cancelButton} onPress={() => setEditModalVisible(false)}>
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Client Journals Modal */}
            <Modal visible={!!selectedClient} animationType="slide" presentationStyle="pageSheet">
                <SafeAreaView style={{flex:1, backgroundColor:'#F7FAFC'}}>
                    <View style={styles.modalHeader}>
                        <Text style={styles.modalTitle}>
                            {selectedClient ? getClientDisplayName(selectedClient) : 'Client'}'s Shared Journal
                        </Text>
                        <TouchableOpacity onPress={() => setSelectedClient(null)}>
                            <FontAwesome name="close" size={24} color="#2D3748" />
                        </TouchableOpacity>
                    </View>

                    {loadingJournals ? <ActivityIndicator size="large" color="#6B4EFF" style={{marginTop: 50}} /> : (
                        <FlatList
                            data={clientJournals}
                            contentContainerStyle={{padding: 20}}
                            keyExtractor={item => item.id}
                            ListEmptyComponent={
                                <View style={{alignItems:'center', marginTop: 50}}>
                                    <FontAwesome name="lock" size={40} color="#CBD5E0" />
                                    <Text style={styles.emptyText}>No shared entries found.</Text>
                                </View>
                            }
                            renderItem={({ item }) => (
                                <View style={styles.journalCard}>
                                    <View style={{flexDirection:'row', justifyContent:'space-between', marginBottom:8}}>
                                        <Text style={styles.journalDate}>
                                            {item.date?.toDate ? new Date(item.date.toDate()).toLocaleDateString() : new Date(item.createdAt?.toDate ? item.createdAt.toDate() : Date.now()).toLocaleDateString()}
                                        </Text>
                                        <View style={styles.moodBadge}>
                                            <Text style={styles.moodText}>Mood: {item.mood}</Text>
                                        </View>
                                    </View>
                                    <Text style={styles.journalText}>{item.text}</Text>
                                </View>
                            )}
                        />
                    )}
                </SafeAreaView>
            </Modal>

            {/* Appointments Modal */}
            <Modal visible={appointmentsModalVisible} animationType="slide" presentationStyle="pageSheet">
                <SafeAreaView style={{flex:1, backgroundColor:'#F7FAFC'}}>
                    <View style={styles.modalHeader}>
                        <Text style={styles.modalTitle}>All Appointments</Text>
                        <TouchableOpacity onPress={() => setAppointmentsModalVisible(false)}>
                            <FontAwesome name="close" size={24} color="#2D3748" />
                        </TouchableOpacity>
                    </View>

                    {loadingAppointments ? (
                        <ActivityIndicator size="large" color="#6B4EFF" style={{marginTop: 50}} />
                    ) : (
                        <FlatList
                            data={appointments}
                            contentContainerStyle={{padding: 20}}
                            keyExtractor={item => item.id}
                            ListEmptyComponent={
                                <View style={{alignItems:'center', marginTop: 50}}>
                                    <FontAwesome name="calendar-o" size={40} color="#CBD5E0" />
                                    <Text style={styles.emptyText}>No appointments scheduled.</Text>
                                </View>
                            }
                            renderItem={({ item }) => (
                                <View style={styles.appointmentCard}>
                                    <View style={styles.appointmentHeader}>
                                        <View>
                                            <Text style={styles.clientName}>{item.clientName}</Text>
                                            <Text style={styles.appointmentDate}>
                                                {item.scheduledTime.toLocaleDateString('en-US', { 
                                                    weekday: 'long', 
                                                    month: 'long', 
                                                    day: 'numeric' 
                                                })}
                                            </Text>
                                            <Text style={styles.appointmentTime}>
                                                {item.scheduledTime.toLocaleTimeString('en-US', { 
                                                    hour: '2-digit', 
                                                    minute: '2-digit' 
                                                })}
                                            </Text>
                                        </View>
                                        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) }]}>
                                            <FontAwesome name={getStatusIcon(item.status)} size={12} color="white" />
                                            <Text style={styles.statusText}>{item.status.toUpperCase()}</Text>
                                        </View>
                                    </View>

                                    <View style={styles.appointmentActions}>
                                        {item.status === 'pending' && (
                                            <TouchableOpacity 
                                                style={[styles.actionBtn, styles.confirmBtn]}
                                                onPress={() => handleConfirmAppointment(item.id)}
                                            >
                                                <FontAwesome name="check" size={14} color="white" />
                                                <Text style={styles.actionBtnText}>Confirm</Text>
                                            </TouchableOpacity>
                                        )}
                                        
                                        {item.status === 'confirmed' && (
                                            <TouchableOpacity 
                                                style={[styles.actionBtn, styles.notesBtn]}
                                                onPress={() => handleOpenClinicalNotes(item)}
                                            >
                                                <FontAwesome name="pencil" size={14} color="white" />
                                                <Text style={styles.actionBtnText}>Notes</Text>
                                            </TouchableOpacity>
                                        )}
                                        
                                        {item.status !== 'cancelled' && (
                                            <TouchableOpacity 
                                                style={[styles.actionBtn, styles.cancelBtn]}
                                                onPress={() => handleCancelAppointment(item.id)}
                                            >
                                                <FontAwesome name="times" size={14} color="white" />
                                                <Text style={styles.actionBtnText}>Cancel</Text>
                                            </TouchableOpacity>
                                        )}
                                    </View>
                                </View>
                            )}
                        />
                    )}
                </SafeAreaView>
            </Modal>

            {/* Schedule Appointment Modal */}
            <Modal visible={scheduleModalVisible} animationType="slide" transparent={true}>
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>Schedule Appointment</Text>
                        
                        <Text style={styles.inputLabel}>Date</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="YYYY-MM-DD"
                            value={scheduleDate}
                            onChangeText={setScheduleDate}
                        />
                        
                        <Text style={styles.inputLabel}>Time</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="HH:MM (24-hour format)"
                            value={scheduleTime}
                            onChangeText={setScheduleTime}
                        />
                        
                        <Text style={styles.inputLabel}>Notes (Optional)</Text>
                        <TextInput
                            style={[styles.input, { height: 80 }]}
                            placeholder="Session focus, preparation notes..."
                            value={scheduleNotes}
                            onChangeText={setScheduleNotes}
                            multiline
                        />

                        <TouchableOpacity style={styles.saveButton} onPress={handleScheduleAppointment}>
                            <Text style={styles.saveText}>Schedule & Notify Client</Text>
                        </TouchableOpacity>

                        <TouchableOpacity 
                            style={styles.cancelButton} 
                            onPress={() => setScheduleModalVisible(false)}
                        >
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Clinical Notes Modal */}
            <Modal visible={notesModalVisible} animationType="slide" presentationStyle="pageSheet">
                <SafeAreaView style={{flex:1, backgroundColor:'#F7FAFC'}}>
                    <View style={styles.modalHeader}>
                        <Text style={styles.modalTitle}>Clinical Notes (Private)</Text>
                        <TouchableOpacity onPress={() => setNotesModalVisible(false)}>
                            <FontAwesome name="close" size={24} color="#2D3748" />
                        </TouchableOpacity>
                    </View>

                    <ScrollView style={{flex:1, padding: 20}}>
                        <View style={styles.securityBanner}>
                            <FontAwesome name="lock" size={16} color="#38A169" />
                            <Text style={styles.securityText}>
                                These notes are private and visible only to you
                            </Text>
                        </View>

                        {selectedAppointment && (
                            <View style={styles.appointmentInfo}>
                                <Text style={styles.infoLabel}>Client:</Text>
                                <Text style={styles.infoValue}>{selectedAppointment.clientName}</Text>
                                
                                <Text style={styles.infoLabel}>Session Date:</Text>
                                <Text style={styles.infoValue}>
                                    {selectedAppointment.scheduledTime.toLocaleDateString('en-US', {
                                        weekday: 'long',
                                        month: 'long',
                                        day: 'numeric',
                                        year: 'numeric'
                                    })} at {selectedAppointment.scheduledTime.toLocaleTimeString('en-US', {
                                        hour: '2-digit',
                                        minute: '2-digit'
                                    })}
                                </Text>
                            </View>
                        )}

                        <Text style={styles.inputLabel}>Session Notes</Text>
                        <TextInput
                            style={[styles.input, styles.notesInput]}
                            placeholder="Document session observations, interventions, progress..."
                            value={clinicalNote}
                            onChangeText={setClinicalNote}
                            multiline
                            textAlignVertical="top"
                        />

                        <TouchableOpacity 
                            style={styles.saveButton} 
                            onPress={handleSaveClinicalNotes}
                            disabled={savingNote}
                        >
                            {savingNote ? (
                                <ActivityIndicator color="white" />
                            ) : (
                                <Text style={styles.saveText}>Save Notes Securely</Text>
                            )}
                        </TouchableOpacity>
                    </ScrollView>
                </SafeAreaView>
            </Modal>

        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#F7FAFC' },
    header: { padding: 20, backgroundColor: '#6B4EFF', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    headerTitle: { color: 'white', fontSize: 20, fontWeight: 'bold' },
    headerSubtitle: { color: '#E9D8FD', fontSize: 14 },
    content: { padding: 20 },
    card: { backgroundColor: 'white', padding: 20, borderRadius: 16, alignItems: 'center', marginBottom: 20, elevation: 2 },
    cardTitle: { fontSize: 14, color: '#718096', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 },
    codeBox: { flexDirection: 'row', alignItems: 'center', gap: 15, backgroundColor: '#F3F0FF', padding: 12, borderRadius: 8, borderWidth: 1, borderColor: '#D6BCFA' },
    codeText: { fontSize: 24, fontWeight: 'bold', color: '#6B4EFF' },
    sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#2D3748', marginBottom: 15, marginTop: 10 },
    clientItemContainer: { marginBottom: 10 },
    clientItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'white', padding: 15, borderRadius: 12, elevation: 1 },
    avatar: { width: 45, height: 45, borderRadius: 25, backgroundColor: '#E2E8F0', alignItems: 'center', justifyContent: 'center', marginRight: 15 },
    avatarText: { fontSize: 18, fontWeight: 'bold', color: '#4A5568' },
    clientName: { fontSize: 16, fontWeight: '600', color: '#2D3748' },
    clientEmail: { fontSize: 12, color: '#718096' },
    scheduleButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#6B4EFF', padding: 10, borderRadius: 8, marginTop: 8, gap: 6 },
    scheduleButtonText: { color: 'white', fontWeight: '600', fontSize: 14 },
    emptyText: { textAlign: 'center', color: '#A0AEC0', marginTop: 20 },
        modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        padding: 20
    },
    modalContent: {
        backgroundColor: 'white',
        borderRadius: 16,
        padding: 20
    },
    modalHeader: {
        padding: 20,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: '#E2E8F0'
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#2D3748'
    },
    input: {
        backgroundColor: '#EDF2F7',
        borderRadius: 10,
        padding: 12,
        marginBottom: 12,
        fontSize: 14,
        color: '#2D3748'
    },
    inputLabel: {
        fontSize: 12,
        fontWeight: '600',
        color: '#4A5568',
        marginBottom: 6,
        marginTop: 10
    },
    saveButton: {
        backgroundColor: '#6B4EFF',
        padding: 14,
        borderRadius: 10,
        alignItems: 'center',
        marginTop: 10
    },
    saveText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 14
    },
    cancelButton: {
        padding: 14,
        borderRadius: 10,
        alignItems: 'center',
        marginTop: 10,
        backgroundColor: '#E2E8F0'
    },
    cancelText: {
        color: '#4A5568',
        fontWeight: '600'
    },
    journalCard: {
        backgroundColor: 'white',
        padding: 16,
        borderRadius: 14,
        marginBottom: 12,
        elevation: 1
    },
    journalDate: {
        fontSize: 12,
        color: '#718096'
    },
    moodBadge: {
        backgroundColor: '#E9D8FD',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12
    },
    moodText: {
        fontSize: 12,
        fontWeight: '600',
        color: '#6B4EFF'
    },
    journalText: {
        fontSize: 14,
        color: '#2D3748',
        marginTop: 6,
        lineHeight: 20
    },
    appointmentCard: {
        backgroundColor: 'white',
        padding: 16,
        borderRadius: 14,
        marginBottom: 14,
        elevation: 1
    },
    appointmentHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 12
    },
    appointmentDate: {
        fontSize: 13,
        color: '#4A5568'
    },
    appointmentTime: {
        fontSize: 13,
        color: '#718096'
    },
    statusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
        gap: 6
    },
    statusText: {
        color: 'white',
        fontSize: 10,
        fontWeight: 'bold'
    },
    appointmentActions: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 8
    },
    actionBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8
    },
    actionBtnText: {
        color: 'white',
        fontSize: 12,
        fontWeight: '600'
    },
    confirmBtn: {
        backgroundColor: '#48BB78'
    },
    cancelBtn: {
        backgroundColor: '#F56565'
    },
    notesBtn: {
        backgroundColor: '#6B4EFF'
    },
    securityBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: '#F0FFF4',
        padding: 12,
        borderRadius: 10,
        marginBottom: 16
    },
    securityText: {
        color: '#2F855A',
        fontSize: 12,
        fontWeight: '600'
    },
    appointmentInfo: {
        backgroundColor: 'white',
        padding: 14,
        borderRadius: 12,
        marginBottom: 16
    },
    infoLabel: {
        fontSize: 12,
        fontWeight: 'bold',
        color: '#718096'
    },
    infoValue: {
        fontSize: 14,
        color: '#2D3748',
        marginBottom: 8
    },
    notesInput: {
        minHeight: 150
    }
});
